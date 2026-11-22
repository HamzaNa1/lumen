import { type ServerInfo, type ServerRoute, sortServerRoutes } from "@lumen/contracts";
import { ServerUnreachableError } from "./errors.ts";

export interface RouteProbeResult {
  readonly route: ServerRoute;
  readonly origin: string;
  readonly identity: ServerInfo;
}

export interface SelectRouteOptions {
  readonly routes: ReadonlyArray<ServerRoute>;
  readonly activeOrigin?: string | null;
  readonly probe: (route: ServerRoute, signal: AbortSignal) => Promise<RouteProbeResult>;
  readonly lanTimeoutMs?: number;
  readonly remoteTimeoutMs?: number;
  /** How long from probe start to wait for an in-flight LAN route after a remote route already answered. */
  readonly lanGraceMs?: number;
  /** How long from probe start to wait for a higher-priority route in the same scope. */
  readonly sameScopeGraceMs?: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_LAN_TIMEOUT_MS = 1_500;
const DEFAULT_REMOTE_TIMEOUT_MS = 5_000;
const DEFAULT_LAN_GRACE_MS = 400;
const DEFAULT_SAME_SCOPE_GRACE_MS = 150;

type ProbeState =
  | { readonly kind: "pending" }
  | { readonly kind: "ok"; readonly result: RouteProbeResult }
  | { readonly kind: "error"; readonly cause: unknown };

const pickFailure = (
  ordered: ReadonlyArray<ServerRoute>,
  states: ReadonlyArray<ProbeState>,
): unknown => {
  // Prefer a concrete manual-route error (such as identity mismatch) over a generic unreachable error.
  for (let index = 0; index < ordered.length; index += 1) {
    const state = states[index];
    if (
      ordered[index]?.source === "manual" &&
      state?.kind === "error" &&
      !(state.cause instanceof ServerUnreachableError)
    )
      return state.cause;
  }
  for (const state of states) if (state.kind === "error") return state.cause;
  return new ServerUnreachableError();
};

/**
 * Probes candidate routes in parallel and returns the highest-priority reachable one (LAN before
 * remote, manual before auto-detected). Resolves as soon as the winning tier is known without
 * waiting on slower lower-priority routes or blackholed LAN addresses.
 */
export const selectBestRoute = async (options: SelectRouteOptions): Promise<RouteProbeResult> => {
  const ordered = sortServerRoutes(options.routes, options.activeOrigin);
  if (ordered.length === 0) throw new ServerUnreachableError();

  const lanTimeoutMs = options.lanTimeoutMs ?? DEFAULT_LAN_TIMEOUT_MS;
  const remoteTimeoutMs = options.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
  const lanGraceMs = options.lanGraceMs ?? DEFAULT_LAN_GRACE_MS;
  const sameScopeGraceMs = options.sameScopeGraceMs ?? DEFAULT_SAME_SCOPE_GRACE_MS;

  const master = new AbortController();
  const startedAt = Date.now();
  const states: ProbeState[] = ordered.map(() => ({ kind: "pending" }));
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  const clearGrace = (): void => {
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
      graceTimer = undefined;
    }
  };

  return new Promise<RouteProbeResult>((resolve, reject) => {
    const finish = (
      outcome: { ok: true; value: RouteProbeResult } | { ok: false; cause: unknown },
    ) => {
      if (settled) return;
      settled = true;
      clearGrace();
      options.signal?.removeEventListener("abort", onExternalAbort);
      master.abort();
      if (outcome.ok) resolve(outcome.value);
      else reject(outcome.cause);
    };

    const onExternalAbort = (): void => {
      finish({
        ok: false,
        cause: options.signal?.reason ?? new Error("Route selection cancelled"),
      });
    };
    if (options.signal?.aborted) {
      onExternalAbort();
      return;
    }
    options.signal?.addEventListener("abort", onExternalAbort, { once: true });

    const bestSuccess = (): {
      readonly index: number;
      readonly result: RouteProbeResult;
    } | null => {
      for (let index = 0; index < states.length; index += 1) {
        const state = states[index];
        if (state?.kind === "ok") return { index, result: state.result };
      }
      return null;
    };

    const evaluate = (): void => {
      if (settled) return;
      const best = bestSuccess();
      if (best === null) {
        if (states.every((state) => state.kind === "error"))
          finish({ ok: false, cause: pickFailure(ordered, states) });
        return;
      }

      const higherPending = ordered
        .slice(0, best.index)
        .filter((_, index) => states[index]?.kind === "pending");

      if (higherPending.length === 0) {
        finish({ ok: true, value: best.result });
        return;
      }

      const waitingOnLanFromRemote =
        ordered[best.index]?.scope === "remote" &&
        higherPending.some((route) => route.scope === "lan");
      const deadlineMs = waitingOnLanFromRemote ? lanGraceMs : sameScopeGraceMs;
      const remaining = Math.max(0, deadlineMs - (Date.now() - startedAt));
      if (remaining === 0) {
        finish({ ok: true, value: best.result });
        return;
      }
      clearGrace();
      graceTimer = setTimeout(() => {
        const currentBest = bestSuccess();
        if (currentBest !== null) finish({ ok: true, value: currentBest.result });
      }, remaining);
    };

    ordered.forEach((route, index) => {
      const timeoutMs = route.scope === "lan" ? lanTimeoutMs : remoteTimeoutMs;
      const signal = AbortSignal.any([master.signal, AbortSignal.timeout(timeoutMs)]);
      void options
        .probe(route, signal)
        .then(
          (result) => {
            states[index] = { kind: "ok", result };
          },
          (cause: unknown) => {
            states[index] = { kind: "error", cause };
          },
        )
        .finally(evaluate);
    });
  });
};
