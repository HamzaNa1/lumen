#pragma once
#include <charconv>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <string_view>

constexpr uint64_t maxSequence = 9007199254740991ULL;
inline void require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
inline uint64_t number(std::string_view text) {
    uint64_t result = 0;
    auto [end, error] = std::from_chars(text.data(), text.data() + text.size(), result);
    require(error == std::errc{} && end == text.data() + text.size() && !text.empty(), "Invalid unsigned integer");
    return result;
}
struct Size { unsigned width = 1280, height = 720; };
inline Size size(uint64_t width, uint64_t height) {
    require(width && height && width <= 8192 && height <= 8192 && width * height <= 33554432, "Invalid texture size");
    return {static_cast<unsigned>(width), static_cast<unsigned>(height)};
}
inline std::string json(std::string_view value) {
    std::string out = "\"";
    constexpr char hex[] = "0123456789abcdef";
    for (unsigned char c : value) {
        if (c == '"' || c == '\\') { out += '\\'; out += static_cast<char>(c); }
        else if (c < 32 || c >= 127) { out += "\\u00"; out += hex[c >> 4]; out += hex[c & 15]; }
        else out += static_cast<char>(c);
    }
    return out + '"';
}
