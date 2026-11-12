#include "helper.h"
#include <array>
#include <bit>
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <thread>

using namespace std::chrono_literals;

void updateCallback(void* opaque) {
    auto& state = *static_cast<Shared*>(opaque);
    { std::lock_guard lock(state.mutex); state.update = true; }
    state.wake.notify_all();
}

Api::Api() {
#define LOAD(name) name = std::bit_cast<decltype(name)>(platform::mpvSymbol("mpv_" #name)); require(name != nullptr, "Missing mpv_" #name)
    LOAD(client_api_version); LOAD(create); LOAD(set_option_string); LOAD(initialize); LOAD(command);
    LOAD(terminate_destroy); LOAD(wait_event); LOAD(render_context_create);
    LOAD(render_context_set_update_callback); LOAD(render_context_update);
    LOAD(render_context_render); LOAD(render_context_free);
#undef LOAD
    require(client_api_version() >= platform::minimumClientApi && (client_api_version() >> 16) == 2,
        "Packaged libmpv has an unsupported client API");
}

namespace {
void render(Shared& state, Api& api, mpv_handle* mpv, const Options& options) {
    Backend backend(state, api, mpv, options);
    std::array<uint64_t, 3> leased{};
    TextureSize dimensions = options.size;
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
                for (auto& slot : leased) if (released && slot == released) { slot = 0; found = true; }
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
        if (update) repaint |= backend.update();
        if (!repaint) continue;
        unsigned free = 0;
        while (free < leased.size() && leased[free]) ++free;
        if (free == leased.size()) { backend.skip(); continue; }
        if (!backend.draw(free, dimensions, options.pattern)) return;
        require(sequence < maxSequence, "Frame sequence exhausted");
        leased[free] = ++sequence; repaint = false;
        auto handle = backend.share(free, sequence);
        state.publish("{\"type\":\"frame\",\"sequence\":" + std::to_string(sequence) +
            ",\"handle\":\"" + handle + "\",\"width\":" + std::to_string(dimensions.width) +
            ",\"height\":" + std::to_string(dimensions.height) + "}");
    }
}

void closeOutput(Shared& state, std::string line) {
    { std::lock_guard lock(state.mutex);
      if (!line.empty() && state.output.size() < 4) state.output.push_back(std::move(line));
      state.outputClosing = true; }
    state.wake.notify_all();
    while (!state.outputDone) std::this_thread::sleep_for(1ms);
}
}

int main(int argc, char** argv) {
    platform::initialize();
    Shared state;
    // This watchdog bounds driver/libmpv teardown and blocked inherited pipe I/O.
    std::thread watchdog([&] {
        while (!state.stop) std::this_thread::sleep_for(20ms);
        std::this_thread::sleep_for(3s);
        platform::exitProcess(1);
    });
    watchdog.detach();
    try {
        Options options;
        uint64_t width = options.size.width, height = options.size.height;
        for (int i = 1; i < argc; ++i) {
            std::string_view arg(argv[i]);
            if (arg.starts_with("--lumen-parent-pid=")) options.parentPid = number(arg.substr(19));
            else if (arg.starts_with("--lumen-width=")) width = number(arg.substr(14));
            else if (arg.starts_with("--lumen-height=")) height = number(arg.substr(15));
            else if (arg.starts_with("--lumen-port=")) options.port = arg.substr(13);
            else if (arg == "--lumen-test-pattern") options.pattern = true;
            else require(!arg.starts_with("--lumen-"), "Unknown Lumen argument");
        }
        options.size = size(width, height);
        platform::monitorParent(state, options.parentPid);
        std::thread input([&] {
            std::string line;
            char c;
            while (!state.stop && platform::readByte(c)) {
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
                if (!platform::write(line)) { state.shutdown("Output pipe failed"); state.outputDone = true; return; }
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
        option("vo", "libmpv"); option("hwdec", platform::hardwareDecoding); option("terminal", "no");
        option("load-scripts", "no"); option("config", "no"); option("idle", "yes");
        option("target-colorspace-hint", "no"); option("target-prim", "bt.709");
        option("target-trc", "auto"); option("target-peak", "auto"); option("tone-mapping", "bt.2390");
        require(api.initialize(mpv) >= 0, "Cannot initialize libmpv");
        std::thread renderer([&] { try { render(state, api, mpv, options); }
            catch (const std::exception& error) { state.shutdown(error.what()); } });
        while (!state.stop) {
            auto event = api.wait_event(mpv, 0.05);
            if (event->event_id == MPV_EVENT_SHUTDOWN) state.shutdown();
        }
        renderer.join();
        api.terminate_destroy(mpv);
        std::string failure;
        { std::lock_guard lock(state.mutex); failure = state.failure; }
        closeOutput(state, failure.empty() ? "" : "{\"type\":\"error\",\"message\":" + json(failure) + "}\n");
        // Detached pipe/parent watchers can still reference state. Process termination
        // preserves their storage until the OS closes all owned resources.
        { std::lock_guard lock(state.mutex); platform::exitProcess(state.failure.empty() ? 0 : 1); }
    } catch (const std::exception& error) {
        state.shutdown(error.what());
        std::cerr << error.what() << '\n';
        std::string line = "{\"type\":\"error\",\"message\":" + json(error.what()) + "}\n";
        if (state.outputStarted) closeOutput(state, line);
        else platform::write(line);
        platform::exitProcess(1);
    }
}
