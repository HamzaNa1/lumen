import { describe, expect, test } from "bun:test";
import { UpdateService, type UpdateAdapter, type UpdateClock } from "../../apps/desktop/src/main/updates/UpdateService";
import { updateEligibility } from "../../apps/desktop/src/main/updates/UpdateEligibility";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { waitForMacStaging } from "../../apps/desktop/src/main/updates/MacStaging";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

describe("desktop update service", () => {
  test("downloads in the background and becomes ready only after staging completes", async () => {
    const staged = deferred<void>();
    let checks = 0;
    const adapter: UpdateAdapter = {
      check: async () => { checks += 1; return { version: "0.0.3", downloadPromise: staged.promise }; },
      onProgress: () => () => undefined,
      onError: () => () => undefined,
    };
    const service = new UpdateService({ adapter, currentVersion: "0.0.2", eligible: true });
    const check = service.checkNow();
    await Promise.resolve();
    expect(service.snapshot().phase).toBe("downloading");
    expect(checks).toBe(1);
    expect(service.checkNow()).toBe(check);
    staged.resolve();
    await check;
    expect(service.snapshot().phase).toBe("ready");
    expect(service.snapshot().availableVersion).toBe("0.0.3");
    service.dispose();
  });

  test("a staging failure never reports ready and can retry", async () => {
    let checks = 0;
    const adapter: UpdateAdapter = {
      check: async () => {
        checks += 1;
        return checks === 1
          ? { version: "0.0.3", downloadPromise: Promise.reject(new Error("checksum mismatch")) }
          : null;
      },
      onProgress: () => () => undefined,
      onError: () => () => undefined,
    };
    const service = new UpdateService({ adapter, currentVersion: "0.0.2", eligible: true });
    await service.checkNow();
    expect(service.snapshot().phase).toBe("error");
    await service.checkNow();
    expect(service.snapshot().phase).toBe("idle");
    service.dispose();
  });

  test("unsupported packages never call the adapter", async () => {
    let checks = 0;
    const service = new UpdateService({
      currentVersion: "0.0.2-rc.1",
      eligible: false,
      unsupportedReason: "Prerelease clients receive manual updates.",
      adapter: {
        check: async () => { checks += 1; return null; },
        onProgress: () => () => undefined,
        onError: () => () => undefined,
      },
    });
    service.start();
    await service.checkNow();
    expect(service.snapshot().phase).toBe("unsupported");
    expect(checks).toBe(0);
    service.dispose();
  });

  test("portable, DEB, prerelease and development clients are excluded", () => {
    const root = mkdtempSync(join(tmpdir(), "lumen-update-test-"));
    try {
      writeFileSync(join(root, "app-update.yml"), "provider: github\n");
      const base = { packaged: true, platform: "win32" as NodeJS.Platform, version: "0.0.2", executablePath: join(root, "Lumen.exe"), resourcesPath: root };
      expect(updateEligibility(base).eligible).toBe(true);
      expect(updateEligibility({ ...base, portableExecutablePath: join(root, "Lumen-Portable.exe") }).eligible).toBe(false);
      expect(updateEligibility({ ...base, platform: "linux" }).eligible).toBe(false);
      expect(updateEligibility({ ...base, version: "0.0.3-rc.1" }).eligible).toBe(false);
      expect(updateEligibility({ ...base, packaged: false }).eligible).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("an error event cannot be overwritten by a late successful promise", async () => {
    const staged = deferred<void>();
    let reportError: (error: unknown) => void = () => undefined;
    const service = new UpdateService({
      currentVersion: "0.0.2", eligible: true,
      adapter: {
        check: async () => ({ version: "0.0.3", downloadPromise: staged.promise }),
        onProgress: () => () => undefined,
        onError: (listener) => { reportError = listener; return () => undefined; },
      },
    });
    const check = service.checkNow();
    await Promise.resolve();
    reportError(new Error("bad signature"));
    staged.resolve();
    await check;
    expect(service.snapshot().phase).toBe("error");
    service.dispose();
  });

  test("older, equal, and prerelease offers stay idle without readiness", async () => {
    for (const version of ["0.0.1", "0.0.2", "0.0.3-rc.1"]) {
      const service = new UpdateService({
        currentVersion: "0.0.2", eligible: true,
        adapter: {
          check: async () => ({ version, downloadPromise: Promise.resolve() }),
          onProgress: () => () => undefined,
          onError: () => () => undefined,
        },
      });
      await service.checkNow();
      expect(service.snapshot().phase).toBe("idle");
      service.dispose();
    }
  });

  test("suspending a pending download prevents a ready notification", async () => {
    const staged = deferred<void>();
    const observed: string[] = [];
    const service = new UpdateService({
      currentVersion: "0.0.2", eligible: true,
      adapter: {
        check: async () => ({ version: "0.0.3", downloadPromise: staged.promise }),
        onProgress: () => () => undefined,
        onError: () => () => undefined,
      },
    });
    service.subscribe((state) => observed.push(state.phase));
    const check = service.checkNow();
    await Promise.resolve();
    service.suspend();
    staged.resolve();
    await check;
    expect(observed).not.toContain("ready");
    service.dispose();
  });

  test("macOS waits for native staging and rejects its failure", async () => {
    const native = new EventEmitter();
    const first = waitForMacStaging(native, 1_000);
    let ready = false;
    void first.promise.then(() => { ready = true; });
    await Promise.resolve();
    expect(ready).toBe(false);
    native.emit("update-downloaded");
    await first.promise;
    expect(ready).toBe(true);
    first.dispose();
    const second = waitForMacStaging(native, 1_000);
    native.emit("error", new Error("staging failed"));
    await expect(second.promise).rejects.toThrow("staging failed");
    second.dispose();
  });

  test("first check is delayed, then successful checks repeat after six hours", async () => {
    const scheduled: { callback: () => void; delay: number }[] = [];
    let now = 0;
    let checks = 0;
    const clock: UpdateClock = {
      now: () => now,
      random: () => 0.5,
      setTimeout: (callback, delay) => {
        const task = { callback, delay };
        scheduled.push(task);
        return { unref: () => undefined } as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => undefined,
    };
    const service = new UpdateService({
      currentVersion: "0.0.2", eligible: true, clock,
      adapter: { check: async () => { checks += 1; return null; }, onProgress: () => () => undefined, onError: () => () => undefined },
    });
    service.start();
    expect(scheduled[0]?.delay).toBe(15_000);
    now = 15_000;
    scheduled[0]?.callback();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(checks).toBe(1);
    expect(scheduled[1]?.delay).toBe(21_600_000);
    service.dispose();
  });
});
