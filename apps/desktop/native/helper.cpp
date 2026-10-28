#include <windows.h>
#include <d3d11_1.h>
#include "protocol.h"
#include <dxgi1_2.h>
#include <wrl/client.h>
#include <mpv/client.h>
#include <mpv/render_d3d11.h>
#include <array>
#include <atomic>
#include <charconv>
#include <bit>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstdlib>
#include <deque>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <thread>

using Microsoft::WRL::ComPtr;
using namespace std::chrono_literals;
[[noreturn]] void exitProcess(UINT code) {
    // Native cleanup is explicit. DLL detach can deadlock after Windows stops
    // another thread holding a CRT/loader lock, so do not run it at process exit.
    TerminateProcess(GetCurrentProcess(), code);
    std::abort();
}
struct Shared {
    std::mutex mutex;
    std::condition_variable wake;
    std::deque<std::string> commands, output;
    std::atomic<bool> stop{false}, outputDone{false};
    bool outputClosing = false, outputStarted = false;
    bool update = true;
    std::string failure;
    void shutdown(std::string message = {}) {
        { std::lock_guard lock(mutex); if (failure.empty()) failure = std::move(message); }
        stop = true; wake.notify_all();
    }
    void publish(std::string line) {
        std::lock_guard lock(mutex);
        require(output.size() < 4, "Output queue overflow");
        output.push_back(std::move(line) + '\n'); wake.notify_all();
    }
};
void callback(void* opaque) {
    auto& state = *static_cast<Shared*>(opaque);
    { std::lock_guard lock(state.mutex); state.update = true; }
    state.wake.notify_all();
}
struct Api {
    HMODULE module = nullptr;
#define API(name) decltype(&mpv_##name) name = nullptr
    API(client_api_version); API(create); API(set_option_string); API(initialize);
    API(terminate_destroy); API(wait_event); API(render_context_create);
    API(render_context_set_update_callback); API(render_context_update);
    API(render_context_render); API(render_context_free);
#undef API
    Api() {
        require(SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_USER_DIRS), "Cannot restrict DLL search");
        std::wstring path(32768, L'\0');
        DWORD length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
        require(length && length < path.size(), "Cannot locate helper");
        path.resize(length); path.resize(path.find_last_of(L"\\/") + 1);
        require(AddDllDirectory(path.c_str()) != nullptr, "Cannot add helper DLL directory");
        module = LoadLibraryExW((path + L"libmpv-2.dll").c_str(), nullptr,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
        require(module != nullptr, "Cannot load packaged libmpv-2.dll");
#define LOAD(name) name = std::bit_cast<decltype(name)>(GetProcAddress(module, "mpv_" #name)); require(name != nullptr, "Missing mpv_" #name)
        LOAD(client_api_version); LOAD(create); LOAD(set_option_string); LOAD(initialize);
        LOAD(terminate_destroy); LOAD(wait_event); LOAD(render_context_create);
        LOAD(render_context_set_update_callback); LOAD(render_context_update);
        LOAD(render_context_render); LOAD(render_context_free);
#undef LOAD
        require(client_api_version() >= MPV_MAKE_VERSION(2, 6) && (client_api_version() >> 16) == 2, "libmpv requires client API 2.6");
    }
    // Keep the module loaded until process exit, including initialization failures:
    // a partially initialized mpv core may still own DLL-backed worker threads.
};
struct Slot {
    ComPtr<ID3D11Texture2D> texture;
    HANDLE handle = nullptr;
    uint64_t sequence = 0;
    Size dimensions{};
    void reset() { if (handle) CloseHandle(handle); handle = nullptr; texture.Reset(); }
    ~Slot() { reset(); }
    void prepare(ID3D11Device* device, Size requested) {
        if (texture && dimensions.width == requested.width && dimensions.height == requested.height) return;
        reset(); dimensions = requested;
        D3D11_TEXTURE2D_DESC desc{};
        desc.Width = requested.width; desc.Height = requested.height;
        desc.MipLevels = 1; desc.ArraySize = 1; desc.SampleDesc.Count = 1;
        desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM; desc.Usage = D3D11_USAGE_DEFAULT;
        desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
        desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED;
        require(SUCCEEDED(device->CreateTexture2D(&desc, nullptr, &texture)), "Cannot create shareable D3D11 texture (hardware adapter required)");
        ComPtr<IDXGIResource1> resource;
        require(SUCCEEDED(texture.As(&resource)), "DXGI NT sharing unavailable");
        require(SUCCEEDED(resource->CreateSharedHandle(nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &handle)), "Cannot create texture NT handle");
    }
};
void render(Shared& state, Api& api, mpv_handle* mpv, Size dimensions, bool pattern) {
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    D3D_FEATURE_LEVEL level;
    require(SUCCEEDED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &device, &level, &context)), "D3D11 hardware device unavailable");
    ComPtr<IDXGIDevice> dxgi;
    ComPtr<IDXGIAdapter> adapter;
    DXGI_ADAPTER_DESC adapterDescription{};
    require(SUCCEEDED(device.As(&dxgi)) && SUCCEEDED(dxgi->GetAdapter(&adapter)) &&
        SUCCEEDED(adapter->GetDesc(&adapterDescription)), "Cannot identify D3D11 adapter");
    std::cerr << "D3D11 adapter LUID " << adapterDescription.AdapterLuid.HighPart << ":"
              << adapterDescription.AdapterLuid.LowPart << "; Electron must import on this adapter\n";
    ComPtr<ID3D11Query> completion;
    D3D11_QUERY_DESC query{D3D11_QUERY_EVENT, 0};
    require(SUCCEEDED(device->CreateQuery(&query, &completion)), "Cannot create GPU completion query");
    mpv_d3d11_init_params init{device.Get()};
    mpv_render_param params[]{{MPV_RENDER_PARAM_API_TYPE, const_cast<char*>(MPV_RENDER_API_TYPE_D3D11)},
        {MPV_RENDER_PARAM_D3D11_INIT_PARAMS, &init}, {MPV_RENDER_PARAM_INVALID, nullptr}};
    mpv_render_context* renderer = nullptr;
    require(api.render_context_create(&renderer, mpv, params) >= 0, "Packaged libmpv direct D3D11 renderer unavailable");
    struct Cleanup { Api& api; mpv_render_context* renderer;
        ~Cleanup() { api.render_context_set_update_callback(renderer, nullptr, nullptr); api.render_context_free(renderer); }
    } cleanup{api, renderer};
    api.render_context_set_update_callback(renderer, callback, &state);
    std::array<Slot, 3> slots;
    uint64_t sequence = 0;
    bool repaint = true;
    state.publish("{\"type\":\"ready\"}");
    while (!state.stop) {
        std::deque<std::string> commands;
        bool update;
        {
            std::unique_lock lock(state.mutex);
            state.wake.wait(lock, [&] { return state.stop || state.update || !state.commands.empty(); });
            commands.swap(state.commands); update = state.update; state.update = false;
        }
        if (state.stop) break;
        for (const auto& command : commands) {
            if (command == "quit") { state.shutdown(); break; }
            if (command.starts_with("release ")) {
                auto released = number(std::string_view(command).substr(8));
                bool found = false;
                for (auto& slot : slots) if (released && slot.sequence == released) {
                    slot.sequence = 0; found = true;
                }
                require(found, "Unknown or duplicate frame release");
            } else if (command.starts_with("resize ")) {
                auto values = std::string_view(command).substr(7);
                auto separator = values.find(' ');
                require(separator != std::string_view::npos, "Malformed resize");
                dimensions = size(number(values.substr(0, separator)), number(values.substr(separator + 1)));
                repaint = true;
            } else throw std::runtime_error("Unknown protocol command");
        }
        if (state.stop) break;
        if (update) repaint |= (api.render_context_update(renderer) & MPV_RENDER_UPDATE_FRAME) != 0;
        if (!repaint) continue;
        Slot* free = nullptr;
        for (auto& slot : slots) if (!slot.sequence) { free = &slot; break; }
        if (!free) {
            int skip = 1;
            mpv_render_param skipParams[]{{MPV_RENDER_PARAM_SKIP_RENDERING, &skip}, {MPV_RENDER_PARAM_INVALID, nullptr}};
            require(api.render_context_render(renderer, skipParams) >= 0, "libmpv skip rendering failed");
            continue;
        }
        free->prepare(device.Get(), dimensions);
        if (pattern) {
            ComPtr<ID3D11RenderTargetView> target;
            require(SUCCEEDED(device->CreateRenderTargetView(free->texture.Get(), nullptr, &target)), "Test target unavailable");
            ComPtr<ID3D11DeviceContext1> context1;
            require(SUCCEEDED(context.As(&context1)), "Test pattern requires D3D11.1");
            const LONG w = static_cast<LONG>(dimensions.width), h = static_cast<LONG>(dimensions.height);
            const D3D11_RECT rectangles[]{{0, 0, w / 2, h / 2}, {w / 2, 0, w, h / 2},
                {0, h / 2, w / 2, h}, {w / 2, h / 2, w, h}};
            const float colors[][4]{{1, 0, 0, 1}, {0, 1, 0, 1}, {0, 0, 1, 1}, {1, 1, 1, 1}};
            for (unsigned i = 0; i < 4; ++i) context1->ClearView(target.Get(), colors[i], &rectangles[i], 1);
        } else {
            mpv_d3d11_fbo fbo{free->texture.Get()};
            mpv_render_param frame[]{{MPV_RENDER_PARAM_D3D11_FBO, &fbo},
                {MPV_RENDER_PARAM_INVALID, nullptr}};
            require(api.render_context_render(renderer, frame) >= 0, "libmpv rendering failed");
        }
        context->End(completion.Get()); context->Flush();
        auto deadline = std::chrono::steady_clock::now() + 2s;
        for (;;) {
            HRESULT result = context->GetData(completion.Get(), nullptr, 0, 0);
            if (result == S_OK) break;
            require(result == S_FALSE && SUCCEEDED(device->GetDeviceRemovedReason()), "D3D11 device lost");
            if (state.stop) return;
            require(std::chrono::steady_clock::now() < deadline, "GPU completion timeout");
            std::this_thread::sleep_for(1ms);
        }
        require(sequence < maxSequence, "Frame sequence exhausted");
        free->sequence = ++sequence; repaint = false;
        state.publish("{\"type\":\"frame\",\"sequence\":" + std::to_string(sequence) +
            ",\"handle\":\"" + std::to_string(reinterpret_cast<uintptr_t>(free->handle)) +
            "\",\"width\":" + std::to_string(dimensions.width) + ",\"height\":" + std::to_string(dimensions.height) + "}");
    }
}
int main(int argc, char** argv) {
    Shared state;
    // This watchdog bounds driver/libmpv teardown and blocked inherited pipe I/O.
    std::thread watchdog([&] {
        while (!state.stop) std::this_thread::sleep_for(20ms);
        std::this_thread::sleep_for(3s);
        TerminateProcess(GetCurrentProcess(), 1);
    });
    watchdog.detach();
    try {
        Size dimensions;
        uint64_t width = dimensions.width, height = dimensions.height;
        uint64_t parentPid = 0;
        bool pattern = false;
        for (int i = 1; i < argc; ++i) {
            std::string_view arg(argv[i]);
            if (arg.starts_with("--lumen-parent-pid=")) parentPid = number(arg.substr(19));
            else if (arg.starts_with("--lumen-width=")) width = number(arg.substr(14));
            else if (arg.starts_with("--lumen-height=")) height = number(arg.substr(15));
            else if (arg == "--lumen-test-pattern") pattern = true;
            else require(!arg.starts_with("--lumen-"), "Unknown Lumen argument");
        }
        dimensions = size(width, height);
        require(parentPid && parentPid <= MAXDWORD && parentPid != GetCurrentProcessId(), "Invalid parent PID");
        HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(parentPid));
        require(parent != nullptr, "Cannot monitor parent process");
        std::thread parentMonitor([&] {
            while (!state.stop && WaitForSingleObject(parent, 50) == WAIT_TIMEOUT) {}
            state.shutdown(); CloseHandle(parent);
        });
        parentMonitor.detach();
        std::thread input([&] {
            std::string line;
            char c; DWORD count;
            while (!state.stop && ReadFile(GetStdHandle(STD_INPUT_HANDLE), &c, 1, &count, nullptr) && count) {
                if (c == '\n') {
                    { std::lock_guard lock(state.mutex);
                      if (state.commands.size() >= 64) { state.failure = "Control queue overflow"; state.stop = true; }
                      else state.commands.push_back(std::move(line)); }
                    line.clear(); state.wake.notify_all();
                } else if (c < 32 || c > 126 || line.size() >= 128) { state.shutdown("Malformed control line"); return; }
                else line += c;
            }
            state.shutdown();
        });
        input.detach();
        std::thread output([&] {
            for (;;) {
                std::string line;
                { std::unique_lock lock(state.mutex);
                  state.wake.wait(lock, [&] { return state.outputClosing || !state.output.empty(); });
                  if (state.output.empty()) { state.outputDone = true; return; }
                  line = std::move(state.output.front()); state.output.pop_front(); }
                DWORD written;
                if (!WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), line.data(), static_cast<DWORD>(line.size()), &written, nullptr) || written != line.size()) {
                    state.shutdown("Output pipe failed"); state.outputDone = true; return;
                }
            }
        });
        output.detach(); state.outputStarted = true;
        Api api;
        mpv_handle* mpv = api.create();
        require(mpv != nullptr, "Cannot create libmpv");
        auto option = [&](const char* key, const char* value) { require(api.set_option_string(mpv, key, value) >= 0, "Invalid libmpv option"); };
        for (int i = 1; i < argc; ++i) {
            std::string arg(argv[i]);
            if (arg.starts_with("--lumen-")) continue;
            require(arg.starts_with("--"), "Expected mpv option");
            auto split = arg.find('=');
            auto key = arg.substr(2, split == std::string::npos ? split : split - 2);
            auto value = split == std::string::npos ? "yes" : arg.substr(split + 1);
            if (split == std::string::npos && key.starts_with("no-")) { key.erase(0, 3); value = "no"; }
            option(key.c_str(), value.c_str());
        }
        option("vo", "libmpv"); option("hwdec", "no"); option("terminal", "no");
        option("load-scripts", "no"); option("config", "no"); option("idle", "yes");
        option("target-colorspace-hint", "no"); option("target-prim", "bt.709");
        option("target-trc", "auto"); option("target-peak", "auto"); option("tone-mapping", "bt.2390");
        require(api.initialize(mpv) >= 0, "Cannot initialize libmpv");
        std::thread renderer([&] { try { render(state, api, mpv, dimensions, pattern); }
            catch (const std::exception& error) { state.shutdown(error.what()); } });
        while (!state.stop) {
            auto event = api.wait_event(mpv, 0.05);
            if (event->event_id == MPV_EVENT_SHUTDOWN) state.shutdown();
        }
        renderer.join();
        api.terminate_destroy(mpv);
        { std::lock_guard lock(state.mutex);
          if (!state.failure.empty() && state.output.size() < 4)
              state.output.push_back("{\"type\":\"error\",\"message\":" + json(state.failure) + "}\n");
          state.outputClosing = true; }
        state.wake.notify_all();
        while (!state.outputDone) std::this_thread::sleep_for(1ms);
        // Detached pipe/parent watchers can still reference state. Process termination
        // preserves their storage until the OS closes all owned resources.
        { std::lock_guard lock(state.mutex); exitProcess(state.failure.empty() ? 0 : 1); }
    } catch (const std::exception& error) {
        state.shutdown(error.what());
        std::cerr << error.what() << '\n';
        std::string line = "{\"type\":\"error\",\"message\":" + json(error.what()) + "}\n";
        DWORD written;
        if (state.outputStarted) {
            { std::lock_guard lock(state.mutex);
              if (state.output.size() < 4) state.output.push_back(line);
              state.outputClosing = true; }
            state.wake.notify_all();
            while (!state.outputDone) std::this_thread::sleep_for(1ms);
        } else WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), line.data(), static_cast<DWORD>(line.size()), &written, nullptr);
        exitProcess(1);
    }
}
