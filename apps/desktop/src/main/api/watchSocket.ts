import NodeWebSocket, { type ClientOptions } from "ws";
import type { PinnedCertificates } from "./PinnedCertificates";

/** Opens watch-group sockets through Node's TLS, trusting the server's pinned LAN certificate. */
export const pinnedSocketOpener =
  (pins: PinnedCertificates) =>
  (url: URL): WebSocket => {
    const options: ClientOptions = {};
    if (url.protocol === "wss:") {
      const trust = pins.tlsOptions(url.hostname);
      options.ca = [...trust.ca];
      // ws hands this to tls.connect, which reads an Error, not the boolean its types declare.
      options.checkServerIdentity = trust.checkServerIdentity as unknown as NonNullable<
        ClientOptions["checkServerIdentity"]
      >;
    }
    // ws implements the browser WebSocket interface the watch client is written against.
    return new NodeWebSocket(url, options) as unknown as WebSocket;
  };
