import type { Page } from "@playwright/test";
import { expect, password, type Server } from "./server";

export async function signIn(page: Page, server: Server, username = "admin") {
  await page.goto(`${server.origin}web/`);
  await expect(page.getByLabel("Username")).toBeVisible();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
}
export async function playing(page: Page) {
  const player = page.getByRole("region", { name: "Media player" });
  await expect.poll(() => player.getAttribute("data-status")).toMatch(/ready|blocked/);
  if ((await player.getAttribute("data-status")) === "blocked")
    await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(player).toHaveAttribute("data-status", "ready");
  let sample = await page.locator("video").evaluate((video: HTMLVideoElement) => ({
    source: video.currentSrc,
    position: video.currentTime,
  }));
  await expect
    .poll(async () => {
      const current = await page.locator("video").evaluate((video: HTMLVideoElement) => ({
        source: video.currentSrc,
        position: video.currentTime,
      }));
      if (current.source !== sample.source) {
        sample = current;
        return false;
      }
      return current.position > sample.position + 0.1;
    })
    .toBe(true);
}
export async function openMovie(page: Page, server: Server, libraryId: string, title = "Film") {
  await page.goto(`${server.origin}web/library/${libraryId}`);
  await page
    .getByRole("button", { name: `Play ${title}`, exact: true })
    .first()
    .click({ force: true });
  await playing(page);
}
export async function pause(page: Page) {
  await page.mouse.move(300, 300);
  await page.getByRole("button", { name: "Pause playback" }).last().click();
  await expect
    .poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.paused))
    .toBe(true);
}
