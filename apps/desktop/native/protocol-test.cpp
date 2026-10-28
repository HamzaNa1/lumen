#include "protocol.h"
#include <iostream>
#include <limits>

template<class F> void rejects(F function) {
    bool failed = false;
    try { function(); } catch (const std::runtime_error&) { failed = true; }
    require(failed, "Invalid input accepted");
}
int main() {
    require(number("9007199254740991") == maxSequence, "Safe sequence boundary");
    require(number("18446744073709551615") == std::numeric_limits<uint64_t>::max(), "Integer boundary");
    for (auto value : {"", "-1", "+1", " 1", "1 ", "1\r", "1 2", "18446744073709551616"})
        rejects([&] { number(value); });
    require(size(8192, 4096).width == 8192, "Pixel cap boundary");
    require(size(1, 8192).height == 8192, "Dimension boundary");
    for (auto invalid : {0ULL, 8193ULL, 4294967297ULL, 18446744073709551615ULL}) {
        rejects([&] { size(invalid, 1); }); rejects([&] { size(1, invalid); });
    }
    rejects([] { size(8192, 4097); });
    require(json("\"\\\n\r\t") == "\"\\\"\\\\\\u000a\\u000d\\u0009\"", "JSON escaping");
    require(json(std::string(1, '\xff')) == "\"\\u00ff\"", "ASCII-only JSON");
    std::cout << "Protocol boundary tests passed\n";
}
