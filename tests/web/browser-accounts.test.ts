import { expect, test } from "bun:test";
import { BrowserAccounts } from "../../apps/web/src/BrowserAccounts";
import type { ServerApi } from "../../packages/client/src/index.ts";

const user = (id: string, username: string) => ({
  id,
  username,
  displayName: username,
  role: "user" as const,
  isActive: true,
  createdAtMs: 1,
  updatedAtMs: 1,
});

const setup = (endActivity: () => Promise<void> = async () => undefined) => {
  const events: string[] = [];
  let session: { user: ReturnType<typeof user>; expiresAtMs: number } | null = {
    user: user("11111111-1111-4111-8111-111111111111", "first"),
    expiresAtMs: Date.now() + 60_000,
  };
  const api = {
    serverOrigin: "http://lumen.test",
    identity: async () => ({ serverId: "server", displayName: "Lumen", apiVersion: "1.0.0" }),
    browserSession: async () => session,
    cancelPending: () => events.push("cancel requests"),
  } as unknown as ServerApi;
  const accounts = new BrowserAccounts(api, async () => {
    events.push("end activity");
    await endActivity();
  });
  accounts.onChange(() => events.push("changed"));
  return {
    accounts,
    api,
    events,
    signInAs: (id: string, username: string) => {
      session = { user: user(id, username), expiresAtMs: Date.now() + 60_000 };
    },
    signOut: () => {
      session = null;
    },
  };
};

test("a tab that finds a different person signed in ends the previous account's activity first", async () => {
  const { accounts, events, signInAs } = setup();
  try {
    expect((await accounts.list()).accounts[0]?.username).toBe("first");
    expect(events).toEqual([]);
    // Another tab signed out and someone else signed in while this one was suspended.
    signInAs("22222222-2222-4222-8222-222222222222", "second");
    await accounts.revalidate();
    expect(events).toEqual(["cancel requests", "end activity", "changed"]);
    const list = await accounts.list();
    expect(list.accounts[0]?.username).toBe("second");
    expect(list.activeConnectionId).toBe("web:22222222-2222-4222-8222-222222222222");
  } finally {
    accounts.dispose();
  }
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((answer) => {
    resolve = answer;
  });
  return { promise, resolve };
};

test("sign-out invalidates an account replacement waiting for teardown", async () => {
  const teardown = deferred<void>();
  const entered = deferred<void>();
  const { accounts, events, signInAs, signOut } = setup(async () => {
    entered.resolve();
    await teardown.promise;
  });
  try {
    await accounts.list();
    signInAs("second", "second");
    const replacement = accounts.revalidate();
    await entered.promise;
    signOut();
    accounts.sessionRejected();
    expect((await accounts.list()).accounts).toEqual([]);
    const changes = events.filter((event) => event === "changed").length;
    teardown.resolve();
    await replacement;
    expect((await accounts.list()).accounts).toEqual([]);
    expect(events.filter((event) => event === "changed")).toHaveLength(changes);
  } finally {
    teardown.resolve();
    accounts.dispose();
  }
});

test("local logout invalidates a replacement before waiting for account teardown", async () => {
  const teardown = deferred<void>();
  const entered = deferred<void>();
  const { accounts, api, signInAs, signOut } = setup(async () => {
    entered.resolve();
    await teardown.promise;
  });
  api.browserLogout = async () => signOut();
  try {
    await accounts.list();
    signInAs("second", "second");
    const replacement = accounts.revalidate();
    await entered.promise;
    const logout = accounts.remove();
    teardown.resolve();
    await Promise.all([replacement, logout]);
    expect((await accounts.list()).accounts).toEqual([]);
  } finally {
    teardown.resolve();
    accounts.dispose();
  }
});

test("sign-out invalidates the first session restore even before an account is adopted", async () => {
  const response = deferred<Awaited<ReturnType<ServerApi["browserSession"]>>>();
  const requested = deferred<void>();
  const { accounts, api } = setup();
  api.browserSession = async () => {
    requested.resolve();
    return response.promise;
  };
  try {
    const restoring = accounts.list();
    await requested.promise;
    accounts.sessionRejected();
    response.resolve({ user: user("stale", "stale"), expiresAtMs: Date.now() + 60_000 });
    expect((await restoring).accounts).toEqual([]);
    expect((await accounts.list()).accounts).toEqual([]);
  } finally {
    accounts.dispose();
  }
});

test("a late negative revalidation cannot forget a more recent replacement", async () => {
  const oldResponse = deferred<Awaited<ReturnType<ServerApi["browserSession"]>>>();
  const { accounts, api, signInAs } = setup();
  try {
    await accounts.list();
    const currentSession = api.browserSession;
    api.browserSession = () => oldResponse.promise;
    const oldRevalidation = accounts.revalidate();
    api.browserSession = currentSession;
    signInAs("second", "second");
    await accounts.revalidate();
    oldResponse.resolve(null);
    await oldRevalidation;
    expect((await accounts.list()).activeConnectionId).toBe("web:second");
  } finally {
    accounts.dispose();
  }
});

test("resume-time validation cannot cancel a pending logout", async () => {
  const teardown = deferred<void>();
  const { accounts, api, signOut } = setup(() => teardown.promise);
  let loggedOut = false;
  api.browserLogout = async () => {
    loggedOut = true;
    signOut();
  };
  try {
    await accounts.list();
    const removing = accounts.remove();
    await accounts.revalidate();
    teardown.resolve();
    await removing;
    expect(loggedOut).toBe(true);
    expect((await accounts.list()).accounts).toEqual([]);
  } finally {
    teardown.resolve();
    accounts.dispose();
  }
});

test("repeated rejection after sign-out does not cancel the sign-in page's requests", async () => {
  const { accounts, events } = setup();
  try {
    await accounts.list();
    accounts.sessionRejected();
    const cancellations = events.filter((event) => event === "cancel requests").length;
    accounts.sessionRejected();
    expect(events.filter((event) => event === "cancel requests")).toHaveLength(cancellations);
    expect((await accounts.list()).accounts).toEqual([]);
  } finally {
    accounts.dispose();
  }
});

test("a cancelled initial restore returns the signed-out snapshot", async () => {
  const response = deferred<Awaited<ReturnType<ServerApi["browserSession"]>>>();
  const requested = deferred<void>();
  const { accounts, api } = setup();
  api.browserSession = async () => {
    requested.resolve();
    await response.promise;
    throw new Error("Request was cancelled");
  };
  try {
    const restoring = accounts.list();
    await requested.promise;
    accounts.sessionRejected();
    response.resolve(null);
    expect((await restoring).accounts).toEqual([]);
  } finally {
    accounts.dispose();
  }
});

test("revalidating the same account disturbs nothing, and a lost session signs out", async () => {
  const { accounts, events, signOut } = setup();
  try {
    await accounts.list();
    await accounts.revalidate();
    expect(events).toEqual([]);
    signOut();
    await accounts.revalidate();
    await Bun.sleep(1);
    expect(events).toEqual(["cancel requests", "changed", "end activity"]);
    expect((await accounts.list()).accounts).toEqual([]);
  } finally {
    accounts.dispose();
  }
});
