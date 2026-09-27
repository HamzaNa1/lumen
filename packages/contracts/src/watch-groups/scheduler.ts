export type CancelScheduled = () => void;
export interface WatchGroupScheduler {
  after(delayMs: number, action: () => void): CancelScheduled;
  every(delayMs: number, action: () => void): CancelScheduled;
}
export const watchGroupScheduler: WatchGroupScheduler = {
  after: (delayMs, action) => {
    const timer = setTimeout(action, delayMs);
    return () => clearTimeout(timer);
  },
  every: (delayMs, action) => {
    const timer = setInterval(action, delayMs);
    return () => clearInterval(timer);
  },
};
