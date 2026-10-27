import { WatchGroupClient } from "../../../packages/client/src/index";
import { test as base, expect } from "./server";

export const test = base.extend<{
  connect: (token: string, readiness?: boolean) => Promise<WatchGroupClient>;
}>({
  connect: async ({ server }, use) => {
    const clients: WatchGroupClient[] = [];
    try {
      await use(async (token, readiness = false) => {
        const client = new WatchGroupClient(
          { serverOrigin: server.origin, watchAuthentication: () => ({ token }) },
          () => {},
          readiness,
        );
        clients.push(client);
        client.connect();
        await expect.poll(() => client.status.connection).toBe("connected");
        return client;
      });
    } finally {
      for (const client of clients) client.close();
    }
  },
});
export { expect } from "./server";
