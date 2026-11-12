#include <windows.h>
#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <wrl/client.h>
#include "helper.h"
#include <mpv/render_d3d11.h>
#include <array>
#include <bit>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <thread>

using Microsoft::WRL::ComPtr;
using namespace std::chrono_literals;

const unsigned long platform::minimumClientApi = MPV_MAKE_VERSION(2, 6);
const char* const platform::hardwareDecoding = "no";

void platform::initialize() {}

[[noreturn]] void platform::exitProcess(int code) {
    // Native cleanup is explicit. DLL detach can deadlock after Windows stops
    // another thread holding a CRT/loader lock, so do not run it at process exit.
    TerminateProcess(GetCurrentProcess(), static_cast<UINT>(code));
    std::abort();
}

bool platform::readByte(char& value) {
    DWORD count;
    return ReadFile(GetStdHandle(STD_INPUT_HANDLE), &value, 1, &count, nullptr) && count;
}

bool platform::write(std::string_view text) {
    DWORD written;
    return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), text.data(), static_cast<DWORD>(text.size()), &written, nullptr) &&
        written == text.size();
}

void* platform::mpvSymbol(const char* name) {
    // Keep the module loaded until process exit, including initialization failures:
    // a partially initialized mpv core may still own DLL-backed worker threads.
    static HMODULE module = [] {
        require(SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32 | LOAD_LIBRARY_SEARCH_USER_DIRS), "Cannot restrict DLL search");
        std::wstring path(32768, L'\0');
        DWORD length = GetModuleFileNameW(nullptr, path.data(), static_cast<DWORD>(path.size()));
        require(length && length < path.size(), "Cannot locate helper");
        path.resize(length); path.resize(path.find_last_of(L"\\/") + 1);
        require(AddDllDirectory(path.c_str()) != nullptr, "Cannot add helper DLL directory");
        HMODULE loaded = LoadLibraryExW((path + L"libmpv-2.dll").c_str(), nullptr,
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
        require(loaded != nullptr, "Cannot load packaged libmpv-2.dll");
        return loaded;
    }();
    return std::bit_cast<void*>(GetProcAddress(module, name));
}

void platform::monitorParent(Shared& state, uint64_t pid) {
    require(pid && pid <= MAXDWORD && pid != GetCurrentProcessId(), "Invalid parent PID");
    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, static_cast<DWORD>(pid));
    require(parent != nullptr, "Cannot monitor parent process");
    std::thread([&state, parent] {
        while (!state.stop && WaitForSingleObject(parent, 50) == WAIT_TIMEOUT) {}
        state.shutdown(); CloseHandle(parent);
    }).detach();
}

namespace {
struct Slot {
    ComPtr<ID3D11Texture2D> texture;
    HANDLE handle = nullptr;
    TextureSize dimensions{};
    void reset() { if (handle) CloseHandle(handle); handle = nullptr; texture.Reset(); }
    ~Slot() { reset(); }
    void prepare(ID3D11Device* device, TextureSize requested) {
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
}

struct Backend::Impl {
    Shared& state;
    Api& api;
    ComPtr<ID3D11Device> device;
    ComPtr<ID3D11DeviceContext> context;
    ComPtr<ID3D11Query> completion;
    mpv_render_context* renderer = nullptr;
    std::array<Slot, 3> slots;
    Impl(Shared& shared, Api& library) : state(shared), api(library) {}
};

Backend::Backend(Shared& state, Api& api, mpv_handle* mpv, const Options&) : impl(std::make_unique<Impl>(state, api)) {
    D3D_FEATURE_LEVEL level;
    require(SUCCEEDED(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &impl->device, &level, &impl->context)), "D3D11 hardware device unavailable");
    ComPtr<IDXGIDevice> dxgi;
    ComPtr<IDXGIAdapter> adapter;
    DXGI_ADAPTER_DESC adapterDescription{};
    require(SUCCEEDED(impl->device.As(&dxgi)) && SUCCEEDED(dxgi->GetAdapter(&adapter)) &&
        SUCCEEDED(adapter->GetDesc(&adapterDescription)), "Cannot identify D3D11 adapter");
    std::cerr << "D3D11 adapter LUID " << adapterDescription.AdapterLuid.HighPart << ":"
              << adapterDescription.AdapterLuid.LowPart << "; Electron must import on this adapter\n";
    D3D11_QUERY_DESC query{D3D11_QUERY_EVENT, 0};
    require(SUCCEEDED(impl->device->CreateQuery(&query, &impl->completion)), "Cannot create GPU completion query");
    mpv_d3d11_init_params init{impl->device.Get()};
    mpv_render_param params[]{{MPV_RENDER_PARAM_API_TYPE, const_cast<char*>(MPV_RENDER_API_TYPE_D3D11)},
        {MPV_RENDER_PARAM_D3D11_INIT_PARAMS, &init}, {MPV_RENDER_PARAM_INVALID, nullptr}};
    require(api.render_context_create(&impl->renderer, mpv, params) >= 0, "Packaged libmpv direct D3D11 renderer unavailable");
    api.render_context_set_update_callback(impl->renderer, updateCallback, &state);
}

Backend::~Backend() {
    impl->api.render_context_set_update_callback(impl->renderer, nullptr, nullptr);
    impl->api.render_context_free(impl->renderer);
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
    slot.prepare(impl->device.Get(), dimensions);
    if (pattern) {
        ComPtr<ID3D11RenderTargetView> target;
        require(SUCCEEDED(impl->device->CreateRenderTargetView(slot.texture.Get(), nullptr, &target)), "Test target unavailable");
        ComPtr<ID3D11DeviceContext1> context1;
        require(SUCCEEDED(impl->context.As(&context1)), "Test pattern requires D3D11.1");
        const LONG w = static_cast<LONG>(dimensions.width), h = static_cast<LONG>(dimensions.height);
        const D3D11_RECT rectangles[]{{0, 0, w / 2, h / 2}, {w / 2, 0, w, h / 2},
            {0, h / 2, w / 2, h}, {w / 2, h / 2, w, h}};
        const float colors[][4]{{1, 0, 0, 1}, {0, 1, 0, 1}, {0, 0, 1, 1}, {1, 1, 1, 1}};
        for (unsigned i = 0; i < 4; ++i) context1->ClearView(target.Get(), colors[i], &rectangles[i], 1);
    } else {
        mpv_d3d11_fbo fbo{slot.texture.Get()};
        mpv_render_param frame[]{{MPV_RENDER_PARAM_D3D11_FBO, &fbo}, {MPV_RENDER_PARAM_INVALID, nullptr}};
        require(impl->api.render_context_render(impl->renderer, frame) >= 0, "libmpv rendering failed");
    }
    impl->context->End(impl->completion.Get()); impl->context->Flush();
    auto deadline = std::chrono::steady_clock::now() + 2s;
    for (;;) {
        HRESULT result = impl->context->GetData(impl->completion.Get(), nullptr, 0, 0);
        if (result == S_OK) return true;
        require(result == S_FALSE && SUCCEEDED(impl->device->GetDeviceRemovedReason()), "D3D11 device lost");
        if (impl->state.stop) return false;
        require(std::chrono::steady_clock::now() < deadline, "GPU completion timeout");
        std::this_thread::sleep_for(1ms);
    }
}

std::string Backend::share(unsigned index, uint64_t) {
    return std::to_string(reinterpret_cast<uintptr_t>(impl->slots.at(index).handle));
}
