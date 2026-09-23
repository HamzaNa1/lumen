# Renderer isolation

The renderer runs with context isolation, sandboxing, no Node integration, a restrictive content security policy, navigation denial, and sender-validated named IPC operations. Credentials and raw MPV commands never cross into renderer state.
