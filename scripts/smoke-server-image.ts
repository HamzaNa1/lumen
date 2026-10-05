// Starts a server image and checks that it serves the web app it was built with.
// Usage: bun scripts/smoke-server-image.ts <image>
import { execFileSync } from "node:child_process";

const image = process.argv[2];
if (image === undefined) throw new Error("Usage: bun scripts/smoke-server-image.ts <image>");

const docker = (...args: string[]): string =>
  execFileSync("docker", args, { encoding: "utf8" }).trim();

const container = docker("run", "--detach", "--publish", "127.0.0.1::3210", image);
try {
  const port = docker("port", container, "3210/tcp").split(":").at(-1);
  const origin = `http://127.0.0.1:${port}`;
  const expectStatus = async (path: string, status: number, init?: RequestInit) => {
    const response = await fetch(`${origin}${path}`, { redirect: "manual", ...init });
    if (response.status !== status)
      throw new Error(`${path} answered ${response.status}; expected ${status}`);
    return response;
  };

  const deadline = Date.now() + 60_000;
  for (;;) {
    const ready = await fetch(`${origin}/health/ready`).catch(() => null);
    if (ready?.ok === true) break;
    if (Date.now() > deadline) throw new Error("The server did not become ready");
    await Bun.sleep(500);
  }

  await expectStatus("/web", 308);
  const page = await (await expectStatus("/web/", 200)).text();
  const assets = [...page.matchAll(/(?:src|href)="(\/web\/assets\/[^"]+)"/gu)].map(
    (match) => match[1] ?? "",
  );
  if (assets.length === 0) throw new Error("The page references no built assets");
  for (const asset of assets) await expectStatus(asset, 200);
  await expectStatus("/web/library/anything", 200);
  await expectStatus("/web/assets/missing.js", 404);
  const info = (await (await expectStatus("/api/v1/server", 200)).json()) as {
    capabilities?: Record<string, boolean>;
  };
  if (info.capabilities?.browserSessions !== true)
    throw new Error("The server does not advertise browser sessions");
  await expectStatus("/api/v1/auth/browser/session", 401);
  console.log(`Verified the web app in ${image}`);
} catch (cause) {
  console.error(docker("logs", container));
  throw cause;
} finally {
  docker("rm", "--force", container);
}
