export class ShutdownCoordinator {
  private mayQuit = false;
  private shutdown: Promise<void> | null = null;

  constructor(private readonly options: {
    readonly suspend: () => void;
    readonly cleanup: () => Promise<void>;
    readonly fallback: () => void | Promise<void>;
    readonly quit: () => void;
    readonly deadlineMs?: number;
  }) {}

  beforeQuit(event: { preventDefault(): void }): void {
    if (this.mayQuit) return;
    event.preventDefault();
    if (this.shutdown !== null) return;
    this.options.suspend();
    this.shutdown = this.run();
  }

  private async run(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        this.options.cleanup(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Shutdown deadline exceeded")), this.options.deadlineMs ?? 5_000);
        }),
      ]);
    } catch {
      try { await this.options.fallback(); }
      catch { /* Process exit releases remaining in-process resources. */ }
    } finally {
      if (timer !== null) clearTimeout(timer);
      this.mayQuit = true;
      this.options.quit();
    }
  }
}
