export type SessionEvent = "signed-in" | "signed-out";

const NAME = "lumen.session";

/**
 * Tells this app's other tabs when the shared session changes. They all hold the same cookie, so
 * a tab that signs out, or finds the session expired, leaves every other tab signed out too.
 */
export class SessionChannel {
  private readonly channel: BroadcastChannel | null;
  private readonly onStorage: (event: StorageEvent) => void;

  constructor(onEvent: (event: SessionEvent) => void) {
    const receive = (value: unknown): void => {
      if (value === "signed-in" || value === "signed-out") onEvent(value);
    };
    this.channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(NAME);
    if (this.channel !== null) this.channel.onmessage = (message) => receive(message.data);
    // Browsers without BroadcastChannel still deliver storage events to other tabs.
    this.onStorage = (event) => {
      if (event.key === NAME && event.newValue !== null) receive(event.newValue.split(":")[0]);
    };
    if (this.channel === null) window.addEventListener("storage", this.onStorage);
  }

  announce(event: SessionEvent): void {
    if (this.channel !== null) {
      this.channel.postMessage(event);
      return;
    }
    try {
      localStorage.setItem(NAME, `${event}:${Date.now()}`);
    } catch {
      // Without storage there is no way to reach the other tabs; each finds out on its next request.
    }
  }

  close(): void {
    if (this.channel !== null) this.channel.close();
    else window.removeEventListener("storage", this.onStorage);
  }
}
