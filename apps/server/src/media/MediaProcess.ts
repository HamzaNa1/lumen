export class MediaProcessError extends Error {}

export interface MediaProcessOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly onStdout?: (chunk: string) => void;
  readonly idleTimeoutMs?: number;
  readonly onExit?: (usage: Bun.ResourceUsage | undefined) => void;
}

/** Drains both pipes, bounds diagnostics, and reaps the child on every exit path. */
export const runMediaProcess = async (
  args: readonly string[],
  options: MediaProcessOptions,
): Promise<string> => {
  options.signal?.throwIfAborted();
  const child = Bun.spawn([...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let failure: Error | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let lastProgress = Date.now();
  const terminate = (cause: Error): void => {
    if (failure !== undefined) return;
    failure = cause;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
  };
  const abort = (): void => terminate(new DOMException("Media operation cancelled", "AbortError"));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(
    () => terminate(new MediaProcessError("Media operation timed out")),
    options.timeoutMs,
  );
  const idle =
    options.idleTimeoutMs === undefined
      ? undefined
      : setInterval(
          () => {
            if (Date.now() - lastProgress > (options.idleTimeoutMs ?? 0))
              terminate(new MediaProcessError("Media operation made no progress"));
          },
          Math.min(1_000, options.idleTimeoutMs),
        );
  const drain = async (stream: ReadableStream<Uint8Array>, capture: boolean): Promise<string> => {
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let size = 0;
    for await (const bytes of stream) {
      size += bytes.byteLength;
      if (size > options.maxOutputBytes && options.onStdout === undefined)
        terminate(new MediaProcessError("Media operation output exceeded limit"));
      const chunk = decoder.decode(bytes, { stream: true });
      if (capture && options.onStdout !== undefined) {
        lastProgress = Date.now();
        options.onStdout(chunk);
      } else if (capture && size <= options.maxOutputBytes) chunks.push(chunk);
      // stderr is drained but never included in an exception: it can contain local paths.
    }
    return chunks.join("") + (capture && options.onStdout === undefined ? decoder.decode() : "");
  };
  try {
    const [stdout, , exit] = await Promise.all([
      drain(child.stdout, true),
      drain(child.stderr, false),
      child.exited,
    ]);
    if (failure !== undefined) throw failure;
    if (exit !== 0) throw new MediaProcessError(`Media operation exited with ${exit}`);
    return stdout;
  } catch (cause) {
    terminate(cause instanceof Error ? cause : new MediaProcessError("Media operation failed"));
    await child.exited;
    throw cause;
  } finally {
    options.onExit?.(child.resourceUsage());
    clearTimeout(timer);
    clearTimeout(killTimer);
    clearInterval(idle);
    options.signal?.removeEventListener("abort", abort);
  }
};
