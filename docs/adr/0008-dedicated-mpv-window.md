# Dedicated MPV window

The first supported desktop path uses a dedicated native MPV window controlled by Electron main. Libmpv embedding remains a platform spike and is not treated as ordinary UI work. This avoids claiming that a DOM element is a native video surface.

Superseded by ADR 0011, which hosts the native video output in a renderer-aligned player surface.
