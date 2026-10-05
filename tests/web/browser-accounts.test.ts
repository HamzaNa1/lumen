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

const setup = () => {
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
  });
  accounts.onChange(() => events.push("changed"));
  return {
    accounts,
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
