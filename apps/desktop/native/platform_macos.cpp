#define GL_SILENCE_DEPRECATION
#include "helper.h"
#include <CoreFoundation/CoreFoundation.h>
#include <IOSurface/IOSurface.h>
#include <OpenGL/CGLIOSurface.h>
#include <OpenGL/OpenGL.h>
#include <OpenGL/gl3.h>
#include <mach-o/dyld.h>
#include <mach/mach.h>
#include <mpv/render_gl.h>
#include <servers/bootstrap.h>
#include <sys/event.h>
#include <array>
#include <cerrno>
#include <chrono>
#include <climits>
#include <csignal>
#include <cstdlib>
#include <dlfcn.h>
#include <iostream>
#include <thread>
#include <unistd.h>

using namespace std::chrono_literals;

// Uses only the long-standing OpenGL render API, so the stable Homebrew release suffices.
const unsigned long platform::minimumClientApi = MPV_MAKE_VERSION(2, 0);
// Decoded frames stay on the GPU and reach OpenGL as IOSurfaces; uploading software-decoded
// frames through Apple's OpenGL cost more than twice the CPU. Unsupported codecs fall back.
const char* const platform::hardwareDecoding = "videotoolbox";

void platform::initialize() {
    // A closed stdout must surface as a write error, not terminate the helper silently.
    signal(SIGPIPE, SIG_IGN);
}

[[noreturn]] void platform::exitProcess(int code) {
    // Detached watchers may still use process state; skip static destructors and atexit.
    _exit(code);
}

bool platform::readByte(char& value) {
    for (;;) {
        auto result = read(STDIN_FILENO, &value, 1);
        if (result == 1) return true;
        if (result < 0 && errno == EINTR) continue;
        return false;
    }
}

bool platform::write(std::string_view text) {
    while (!text.empty()) {
        auto written = ::write(STDOUT_FILENO, text.data(), text.size());
        if (written < 0 && errno == EINTR) continue;
        if (written <= 0) return false;
        text.remove_prefix(static_cast<size_t>(written));
    }
    return true;
}

void* platform::mpvSymbol(const char* name) {
    // Keep libmpv loaded until process exit: a partially initialized core may own its threads.
    static void* library = [] {
        uint32_t length = 0;
        _NSGetExecutablePath(nullptr, &length);
        std::string path(length, '\0');
        require(_NSGetExecutablePath(path.data(), &length) == 0, "Cannot locate helper");
        char resolved[PATH_MAX];
        require(realpath(path.c_str(), resolved) != nullptr, "Cannot resolve helper path");
        std::string directory(resolved);
        directory.resize(directory.find_last_of('/') + 1);
        // The bundled copy ships beside the helper; Homebrew's serves unpackaged development builds.
        for (auto candidate : {directory + "libmpv.dylib", std::string("/opt/homebrew/opt/mpv/lib/libmpv.dylib"),
                 std::string("/usr/local/opt/mpv/lib/libmpv.dylib")}) {
            if (access(candidate.c_str(), F_OK) != 0) continue;
            void* loaded = dlopen(candidate.c_str(), RTLD_NOW | RTLD_LOCAL);
            require(loaded != nullptr, "Cannot load libmpv.dylib");
            return loaded;
        }
        throw std::runtime_error("libmpv.dylib is missing");
    }();
    return dlsym(library, name);
}

void platform::monitorParent(Shared& state, uint64_t pid) {
    require(pid && pid <= INT_MAX && static_cast<pid_t>(pid) == getppid(), "Invalid parent PID");
    int queue = kqueue();
    require(queue >= 0, "Cannot monitor parent process");
    struct kevent change;
    EV_SET(&change, static_cast<uintptr_t>(pid), EVFILT_PROC, EV_ADD, NOTE_EXIT, 0, nullptr);
    require(kevent(queue, &change, 1, nullptr, 0, nullptr) == 0, "Cannot monitor parent process");
    std::thread([&state, queue] {
        const timespec timeout{0, 50'000'000};
        struct kevent event;
        for (;;) {
            if (state.stop) break;
            int result = kevent(queue, nullptr, 0, &event, 1, &timeout);
            if (result == 0 || (result < 0 && errno == EINTR)) continue;
            break;
        }
        state.shutdown(); close(queue);
    }).detach();
}

namespace {
constexpr mach_msg_id_t frameMessage = 0x4c554d;
#pragma pack(push, 4)
struct FrameMessage {
    mach_msg_header_t header;
    mach_msg_body_t body;
    mach_msg_port_descriptor_t surface;
    uint64_t sequence;
};
#pragma pack(pop)
static_assert(sizeof(FrameMessage) == 48, "Electron parses this layout");

struct Slot {
    IOSurfaceRef surface = nullptr;
    GLuint texture = 0, framebuffer = 0;
    TextureSize dimensions{};
};

void setNumber(CFMutableDictionaryRef dictionary, CFStringRef key, int value) {
    CFNumberRef number = CFNumberCreate(nullptr, kCFNumberIntType, &value);
    CFDictionarySetValue(dictionary, key, number);
    CFRelease(number);
}

void* glSymbol(void* library, const char* name) { return dlsym(library, name); }
}

struct Backend::Impl {
    Shared& state;
    Api& api;
    mach_port_t server = MACH_PORT_NULL;
    void* opengl = nullptr;
    CGLContextObj context = nullptr;
    mpv_render_context* renderer = nullptr;
    std::array<Slot, 3> slots;
    Impl(Shared& shared, Api& library) : state(shared), api(library) {}

    void reset(Slot& slot) {
        if (slot.framebuffer) glDeleteFramebuffers(1, &slot.framebuffer);
        if (slot.texture) glDeleteTextures(1, &slot.texture);
        if (slot.surface) CFRelease(slot.surface);
        slot = {};
    }

    void prepare(Slot& slot, TextureSize requested) {
        if (slot.surface && slot.dimensions.width == requested.width && slot.dimensions.height == requested.height) return;
        reset(slot);
        slot.dimensions = requested;
        CFMutableDictionaryRef properties = CFDictionaryCreateMutable(nullptr, 0,
            &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
        setNumber(properties, kIOSurfaceWidth, static_cast<int>(requested.width));
        setNumber(properties, kIOSurfaceHeight, static_cast<int>(requested.height));
        setNumber(properties, kIOSurfaceBytesPerElement, 4);
        setNumber(properties, kIOSurfacePixelFormat, 'BGRA');
        slot.surface = IOSurfaceCreate(properties);
        CFRelease(properties);
        require(slot.surface != nullptr, "Cannot create shareable IOSurface");
        glGenTextures(1, &slot.texture);
        glBindTexture(GL_TEXTURE_RECTANGLE, slot.texture);
        require(CGLTexImageIOSurface2D(context, GL_TEXTURE_RECTANGLE, GL_RGBA,
            static_cast<GLsizei>(requested.width), static_cast<GLsizei>(requested.height),
            GL_BGRA, GL_UNSIGNED_INT_8_8_8_8_REV, slot.surface, 0) == kCGLNoError, "Cannot bind IOSurface texture");
        glBindTexture(GL_TEXTURE_RECTANGLE, 0);
        glGenFramebuffers(1, &slot.framebuffer);
        glBindFramebuffer(GL_FRAMEBUFFER, slot.framebuffer);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_RECTANGLE, slot.texture, 0);
        require(glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE, "IOSurface framebuffer incomplete");
    }
};

Backend::Backend(Shared& state, Api& api, mpv_handle* mpv, const Options& options) : impl(std::make_unique<Impl>(state, api)) {
    require(!options.port.empty(), "Missing texture port");
    require(bootstrap_look_up(bootstrap_port, options.port.c_str(), &impl->server) == KERN_SUCCESS, "Cannot reach the texture port");
    impl->opengl = dlopen("/System/Library/Frameworks/OpenGL.framework/OpenGL", RTLD_NOW | RTLD_LOCAL);
    require(impl->opengl != nullptr, "Cannot load OpenGL");
    const auto profile = static_cast<CGLPixelFormatAttribute>(kCGLOGLPVersion_3_2_Core);
    const CGLPixelFormatAttribute hardware[]{
        kCGLPFAOpenGLProfile, profile, kCGLPFAAccelerated, kCGLPFAAllowOfflineRenderers, static_cast<CGLPixelFormatAttribute>(0)};
    // Virtual machines, including hosted CI runners, expose Metal but no accelerated OpenGL renderer.
    const CGLPixelFormatAttribute software[]{kCGLPFAOpenGLProfile, profile, kCGLPFARendererID,
        static_cast<CGLPixelFormatAttribute>(kCGLRendererGenericFloatID), static_cast<CGLPixelFormatAttribute>(0)};
    CGLPixelFormatObj format = nullptr;
    GLint formats = 0;
    if (CGLChoosePixelFormat(hardware, &format, &formats) != kCGLNoError || !format) {
        std::cerr << "No accelerated OpenGL renderer; using Apple Software Renderer\n";
        require(CGLChoosePixelFormat(software, &format, &formats) == kCGLNoError && format, "OpenGL unavailable");
        // mpv's default scalers render far below the frame rate on the CPU.
        const char* fast[]{"apply-profile", "fast", nullptr};
        require(api.command(mpv, fast) >= 0, "Cannot apply the fast profile");
    }
    auto created = CGLCreateContext(format, nullptr, &impl->context);
    CGLReleasePixelFormat(format);
    require(created == kCGLNoError && impl->context, "Cannot create OpenGL context");
    require(CGLSetCurrentContext(impl->context) == kCGLNoError, "Cannot use OpenGL context");
    mpv_opengl_init_params init{glSymbol, impl->opengl};
    mpv_render_param params[]{{MPV_RENDER_PARAM_API_TYPE, const_cast<char*>(MPV_RENDER_API_TYPE_OPENGL)},
        {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &init}, {MPV_RENDER_PARAM_INVALID, nullptr}};
    require(api.render_context_create(&impl->renderer, mpv, params) >= 0, "libmpv OpenGL renderer unavailable");
    api.render_context_set_update_callback(impl->renderer, updateCallback, &state);
}

Backend::~Backend() {
    if (impl->context) CGLSetCurrentContext(impl->context);
    if (impl->renderer) {
        impl->api.render_context_set_update_callback(impl->renderer, nullptr, nullptr);
        impl->api.render_context_free(impl->renderer);
    }
    if (impl->context) {
        for (auto& slot : impl->slots) impl->reset(slot);
        CGLSetCurrentContext(nullptr);
        CGLDestroyContext(impl->context);
    }
    if (impl->server != MACH_PORT_NULL) mach_port_deallocate(mach_task_self(), impl->server);
}

bool Backend::update() {
    return (impl->api.render_context_update(impl->renderer) & MPV_RENDER_UPDATE_FRAME) != 0;
}

void Backend::skip() {
    int skip = 1;
    mpv_render_param params[]{{MPV_RENDER_PARAM_SKIP_RENDERING, &skip}, {MPV_RENDER_PARAM_INVALID, nullptr}};
    require(impl->api.render_context_render(impl->renderer, params) >= 0, "libmpv skip rendering failed");
}

bool Backend::draw(unsigned index, TextureSize dimensions, bool pattern) {
    auto& slot = impl->slots.at(index);
    impl->prepare(slot, dimensions);
    glBindFramebuffer(GL_FRAMEBUFFER, slot.framebuffer);
    const auto w = static_cast<GLsizei>(dimensions.width), h = static_cast<GLsizei>(dimensions.height);
    if (pattern) {
        // IOSurface row 0 is the top of the picture and also GL's y = 0.
        const GLint rectangles[][4]{{0, 0, w / 2, h / 2}, {w / 2, 0, w - w / 2, h / 2},
            {0, h / 2, w / 2, h - h / 2}, {w / 2, h / 2, w - w / 2, h - h / 2}};
        const float colors[][4]{{1, 0, 0, 1}, {0, 1, 0, 1}, {0, 0, 1, 1}, {1, 1, 1, 1}};
        glViewport(0, 0, w, h);
        glEnable(GL_SCISSOR_TEST);
        for (unsigned i = 0; i < 4; ++i) {
            glScissor(rectangles[i][0], rectangles[i][1], rectangles[i][2], rectangles[i][3]);
            glClearColor(colors[i][0], colors[i][1], colors[i][2], colors[i][3]);
            glClear(GL_COLOR_BUFFER_BIT);
        }
        glDisable(GL_SCISSOR_TEST);
    } else {
        // Unflipped, mpv writes the top row of the picture at y = 0, which is IOSurface row 0.
        mpv_opengl_fbo fbo{static_cast<int>(slot.framebuffer), w, h, 0};
        mpv_render_param frame[]{{MPV_RENDER_PARAM_OPENGL_FBO, &fbo}, {MPV_RENDER_PARAM_INVALID, nullptr}};
        require(impl->api.render_context_render(impl->renderer, frame) >= 0, "libmpv rendering failed");
    }
    GLsync fence = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
    require(fence != nullptr, "Cannot create GPU completion fence");
    glFlush();
    auto deadline = std::chrono::steady_clock::now() + 2s;
    for (;;) {
        GLenum result = glClientWaitSync(fence, 0, 1'000'000);
        if (result == GL_ALREADY_SIGNALED || result == GL_CONDITION_SATISFIED) { glDeleteSync(fence); return true; }
        if (result == GL_WAIT_FAILED) { glDeleteSync(fence); throw std::runtime_error("OpenGL device lost"); }
        if (impl->state.stop) { glDeleteSync(fence); return false; }
        if (std::chrono::steady_clock::now() >= deadline) { glDeleteSync(fence); throw std::runtime_error("GPU completion timeout"); }
    }
}

std::string Backend::share(unsigned index, uint64_t sequence) {
    auto& slot = impl->slots.at(index);
    // The texture travels ahead of its stdout record, so Electron finds it already queued.
    mach_port_t surface = IOSurfaceCreateMachPort(slot.surface);
    require(surface != MACH_PORT_NULL, "Cannot share IOSurface");
    FrameMessage message{};
    message.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) | MACH_MSGH_BITS_COMPLEX;
    message.header.msgh_size = sizeof message;
    message.header.msgh_remote_port = impl->server;
    message.header.msgh_id = frameMessage;
    message.body.msgh_descriptor_count = 1;
    message.surface.name = surface;
    message.surface.disposition = MACH_MSG_TYPE_MOVE_SEND;
    message.surface.type = MACH_MSG_PORT_DESCRIPTOR;
    message.sequence = sequence;
    auto result = mach_msg(&message.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT, sizeof message, 0,
        MACH_PORT_NULL, 2000, MACH_PORT_NULL);
    if (result != MACH_MSG_SUCCESS) {
        mach_port_deallocate(mach_task_self(), surface);
        throw std::runtime_error("Cannot send video texture to Electron");
    }
    return std::to_string(IOSurfaceGetID(slot.surface));
}
