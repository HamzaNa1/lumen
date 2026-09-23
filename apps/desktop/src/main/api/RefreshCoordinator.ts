import type { AccountSession } from "./ServerClient";

export class RefreshCoordinator {
  private readonly inFlight = new Map<string, Promise<AccountSession>>();

  refresh(connectionId: string, refresh: () => Promise<AccountSession>): Promise<AccountSession> {
    const existing = this.inFlight.get(connectionId);
    if (existing !== undefined) return existing;
    const next = refresh().finally(() => this.inFlight.delete(connectionId));
    this.inFlight.set(connectionId, next);
    return next;
  }
}
