import { hashToken, newOpaqueToken } from "../../core/Security";
import { GroupFailure } from "./GroupFailure";
export interface TicketBinding {
  readonly serverInstanceId: string;
  readonly groupId: string;
  readonly membershipId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly sessionId: string;
}
export class ConnectionTickets {
  private readonly entries = new Map<string, { binding: TicketBinding; expires: number }>();
  constructor(
    private readonly capacity: number,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}
  issue(binding: TicketBinding): string {
    this.sweep();
    if (this.entries.size >= this.capacity)
      throw new GroupFailure("capacity", "Too many pending connections");
    const token = newOpaqueToken();
    this.entries.set(hashToken(token), { binding, expires: this.now() + this.ttlMs });
    return token;
  }
  consume(token: string): TicketBinding {
    const key = hashToken(token);
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (entry === undefined || entry.expires <= this.now())
      throw new GroupFailure("membership_expired", "Connection ticket is invalid or expired");
    return entry.binding;
  }
  sweep(): void {
    for (const [key, entry] of this.entries)
      if (entry.expires <= this.now()) this.entries.delete(key);
  }
  clear(): void {
    this.entries.clear();
  }
}
