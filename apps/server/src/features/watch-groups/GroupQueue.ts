import { GroupFailure } from "./GroupFailure";

interface QueuedWork {
  readonly run: () => Promise<void>;
  readonly reject: (error: Error) => void;
}

export class GroupQueue {
  private readonly controls: QueuedWork[] = [];
  private readonly lifecycle: QueuedWork[] = [];
  private readonly lifecycleKeys = new Map<string, Promise<void>>();
  private readonly idleWaiters: (() => void)[] = [];
  private controlDepth = 0;
  private running = false;
  private closed = false;
  constructor(
    private readonly capacity: number,
    private readonly lifecycleCapacity = 0,
  ) {}
  get depth(): number {
    return this.controlDepth + this.lifecycleKeys.size;
  }
  run<A>(action: () => Promise<A> | A): Promise<A> {
    if (this.closed) return Promise.reject(this.closedError());
    if (this.controlDepth >= this.capacity) return Promise.reject(this.capacityError());
    this.controlDepth++;
    const work = this.enqueue(this.controls, action);
    void work.then(
      () => { this.controlDepth--; },
      () => { this.controlDepth--; },
    );
    return work;
  }
  // Callers reserve one key per member, plus maintenance and the end timer.
  runLifecycle(key: string, action: () => Promise<void> | void): Promise<void> {
    if (this.closed) return Promise.reject(this.closedError());
    const pending = this.lifecycleKeys.get(key);
    if (pending !== undefined) return pending;
    if (this.lifecycleKeys.size >= this.lifecycleCapacity)
      return Promise.reject(this.capacityError());
    const work = this.enqueue(this.lifecycle, action);
    this.lifecycleKeys.set(key, work);
    const clear = () => { this.lifecycleKeys.delete(key); };
    void work.then(clear, clear);
    return work;
  }
  close(): void {
    this.closed = true;
    for (const work of [...this.lifecycle.splice(0), ...this.controls.splice(0)])
      work.reject(this.closedError());
  }
  idle(): Promise<void> {
    if (!this.running) return Promise.resolve();
    return new Promise((resolve) => { this.idleWaiters.push(resolve); });
  }
  private enqueue<A>(queue: QueuedWork[], action: () => Promise<A> | A): Promise<A> {
    const work = new Promise<A>((resolve, reject) => {
      queue.push({
        reject,
        run: async () => {
          try { resolve(await action()); }
          catch (error) { reject(error); }
        },
      });
    });
    if (!this.running) {
      this.running = true;
      void this.drain();
    }
    return work;
  }
  private async drain(): Promise<void> {
    for (let work = this.next(); work !== undefined; work = this.next()) await work.run();
    this.running = false;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }
  private next(): QueuedWork | undefined {
    return this.lifecycle.shift() ?? this.controls.shift();
  }
  private closedError(): Error {
    return new GroupFailure("unavailable", "Watch group is closed");
  }
  private capacityError(): Error {
    return new GroupFailure("capacity", "Watch group is busy; retry shortly");
  }
}
