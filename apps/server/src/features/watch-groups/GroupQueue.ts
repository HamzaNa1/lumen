import { GroupFailure } from "./GroupFailure";
export class GroupQueue {
  private tail = Promise.resolve();
  private depth = 0;
  private closed = false;
  constructor(private readonly capacity: number) {}
  run<A>(action: () => Promise<A> | A): Promise<A> {
    if (this.closed)
      return Promise.reject(new GroupFailure("unavailable", "Watch group is closed"));
    if (this.depth >= this.capacity)
      return Promise.reject(new GroupFailure("capacity", "Watch group is busy; retry shortly"));
    this.depth++;
    const work = this.tail.then(() => {
      if (this.closed) throw new GroupFailure("unavailable", "Watch group is closed");
      return action();
    });
    this.tail = work.then(
      () => {
        this.depth--;
      },
      () => {
        this.depth--;
      },
    );
    return work;
  }
  close(): void {
    this.closed = true;
  }
  idle(): Promise<void> {
    return this.tail;
  }
}
