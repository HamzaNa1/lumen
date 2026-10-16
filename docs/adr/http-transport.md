# HTTP transport for media

## Decision

Serve HTTP and the watch-group WebSocket through `node:http` and `ws` (`apps/server/src/http/HttpServer.ts`) instead of `Bun.serve`. Every response keeps the `Content-Length` its handler set, and each request can still lift the 10-second idle timeout for itself.

Media responses need both. A paused player can leave a download idle for longer than the server's idle timeout, so media requests turn that timeout off. In Bun 1.4, a file body resets the timeout to the server default. The previous workaround piped the file through an identity `TransformStream`, but Bun sends every streamed body with `Transfer-Encoding: chunked` and drops the explicit length.

Linux WebKit (GStreamer) treats a range response without a length as not seekable until the response finishes. With the tail-indexed WebM fixture, a seek that lands during that window fails in `matroskademux` with "Failed to seek" / "Could not demultiplex stream". The player then shows "Playback failed". This happens on startup with resume and when Previous restarts an episode. Controlled reproductions failed 20 of 20 with chunked responses and passed 20 of 20 with length-delimited responses, using the same file.

## Alternatives

- **Front-loading the fixture's cue index.** This removes the startup seek to the file's tail, but restarts still issued seeks while a chunked response was open, and they stalled. Real libraries contain tail-indexed files, so the transport must be correct for them.
- **Returning the file body directly from `Bun.serve`.** This keeps the length but resets the idle timeout, which brings back the dropped paused downloads.
- **Raising or disabling the server-wide idle timeout.** This removes slow-client protection from every route to work around one.
- **Retries, longer test timeouts, or skipping WebKit.** These hide a fault that users of WebKit-based players hit.
