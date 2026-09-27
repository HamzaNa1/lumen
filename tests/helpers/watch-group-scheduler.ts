import type { WatchGroupScheduler } from "../../packages/contracts/src";
export class FakeGroupScheduler implements WatchGroupScheduler {
  now = 0;
  private sequence = 0;
  private readonly tasks = new Map<
    number,
    { at: number; action: () => void; interval: number | null }
  >();
  after(delay: number, action: () => void): () => void {
    return this.add(delay, action, null);
  }
  every(delay: number, action: () => void): () => void {
    return this.add(delay, action, delay);
  }
  advance(ms: number): void {
    const target = this.now + ms;
    while (true) {
      const next = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (next === undefined) break;
      const [id, task] = next;
      this.now = task.at;
      if (task.interval === null) this.tasks.delete(id);
      else task.at += task.interval;
      task.action();
    }
    this.now = target;
  }
  get size(): number {
    return this.tasks.size;
  }
  private add(delay: number, action: () => void, interval: number | null): () => void {
    const id = this.sequence++;
    this.tasks.set(id, { at: this.now + delay, action, interval });
    return () => {
      this.tasks.delete(id);
    };
  }
}
