import type { BrowserContext } from "@playwright/test";

declare global {
  interface Window {
    __reportE2EBrowserError: (message: string) => Promise<void>;
  }
}

export async function collectBrowserErrors(context: BrowserContext): Promise<string[]> {
  const errors: string[] = [];
  await context.exposeBinding("__reportE2EBrowserError", (_source, message: string) => {
    errors.push(message);
  });
  // WebKit also emits pageerror for handled fetch cancellations during navigation.
  // Observe uncaught JavaScript at its source, consistently across browser engines.
  // https://github.com/microsoft/playwright/issues/43120
  await context.addInitScript(() => {
    const report = (cause: unknown): void => {
      const message =
        cause instanceof Error
          ? `${cause.name}: ${cause.message}\n${cause.stack ?? ""}`
          : String(cause);
      void window.__reportE2EBrowserError(message).catch(() => undefined);
    };
    window.addEventListener("error", (event) => report(event.error ?? event.message));
    window.addEventListener("unhandledrejection", (event) => report(event.reason));
  });
  context.on("page", (page) => page.on("crash", () => errors.push(`Page crashed: ${page.url()}`)));
  return errors;
}
