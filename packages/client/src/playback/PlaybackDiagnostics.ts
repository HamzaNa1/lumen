export interface PlaybackDiagnosticEvent {
  readonly atMs: number;
  readonly kind: string;
  readonly fields: Readonly<Record<string, string | number | boolean | null>>;
}

/** Only callers' selected metrics enter this bounded export, never URLs, headers or errors. */
export class PlaybackDiagnostics {
  private readonly events: PlaybackDiagnosticEvent[] = [];

  record(kind: string, fields: PlaybackDiagnosticEvent["fields"]): void {
    this.events.push({ atMs: Date.now(), kind, fields });
    if (this.events.length > 256) this.events.shift();
  }

  snapshot(): ReadonlyArray<PlaybackDiagnosticEvent> {
    return this.events.map((event) => ({ ...event, fields: { ...event.fields } }));
  }
}
