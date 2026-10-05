import { LimitExceeded } from "../core/Limits";

/** Admission covers the response body, independently of short-lived control requests. */
export class MediaResponseLimiter {
  private active = 0;
  private readonly clients = new Map<string, number>();

  constructor(
    private readonly globalLimit: number,
    private readonly perClientLimit: number,
  ) {}

  async run(
    key: string,
    request: Request,
    create: () => Promise<Response>,
    onRelease: () => void = () => undefined,
  ): Promise<Response> {
    const count = this.clients.get(key) ?? 0;
    if (this.active >= this.globalLimit || count >= this.perClientLimit)
      throw new LimitExceeded({ retryAfterSeconds: 1 });
    this.active += 1;
    this.clients.set(key, count + 1);
    let released = false;
    let reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel"> | undefined;
    let abort: () => void = () => undefined;
    const release = (): void => {
      if (released) return;
      released = true;
      this.active -= 1;
      const remaining = (this.clients.get(key) ?? 1) - 1;
      if (remaining === 0) this.clients.delete(key);
      else this.clients.set(key, remaining);
      request.signal.removeEventListener("abort", abort);
      onRelease();
    };
    try {
      const response = await create();
      if (response.body === null) {
        release();
        return response;
      }
      reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>(
        {
          start: (controller) => {
            abort = () => {
              void reader
                ?.cancel()
                .catch(() => undefined)
                .finally(release);
              controller.error(new DOMException("Media response cancelled", "AbortError"));
            };
            request.signal.addEventListener("abort", abort, { once: true });
            if (request.signal.aborted) abort();
          },
          pull: async (controller) => {
            try {
              const next = await reader?.read();
              if (next?.done === true || next === undefined) {
                release();
                controller.close();
              } else controller.enqueue(next.value);
            } catch (cause) {
              release();
              controller.error(cause);
            }
          },
          cancel: async (reason) => {
            try {
              await reader?.cancel(reason);
            } finally {
              release();
            }
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (cause) {
      release();
      throw cause;
    }
  }
}
