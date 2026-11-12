#pragma once
#include "protocol.h"
#include <mpv/client.h>
#include <mpv/render.h>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <string_view>

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

struct Options {
    TextureSize size;
    bool pattern = false;
    uint64_t parentPid = 0;
    std::string port;
};

namespace platform {
extern const unsigned long minimumClientApi;
extern const char* const hardwareDecoding;
void initialize();
[[noreturn]] void exitProcess(int code);
bool readByte(char& value);
bool write(std::string_view text);
void* mpvSymbol(const char* name);
void monitorParent(Shared& state, uint64_t pid);
}

struct Api {
#define API(name) decltype(&mpv_##name) name = nullptr
    API(client_api_version); API(create); API(set_option_string); API(initialize); API(command);
    API(terminate_destroy); API(wait_event); API(render_context_create);
    API(render_context_set_update_callback); API(render_context_update);
    API(render_context_render); API(render_context_free);
#undef API
    Api();
};

/** The platform's GPU renderer. It is created, used and destroyed on the render thread. */
class Backend {
public:
    Backend(Shared& state, Api& api, mpv_handle* mpv, const Options& options);
    ~Backend();
    Backend(const Backend&) = delete;
    Backend& operator=(const Backend&) = delete;
    bool update();
    void skip();
    /** Draws into a slot and waits for the GPU; false when shutdown interrupted the wait. */
    bool draw(unsigned slot, TextureSize dimensions, bool pattern);
    /** Hands the slot to Electron out of band where needed; returns the frame's handle text. */
    std::string share(unsigned slot, uint64_t sequence);
private:
    struct Impl;
    std::unique_ptr<Impl> impl;
};

void updateCallback(void* opaque);
