import { expect, type Page } from "@playwright/test";

/** Waits for usable controls and advancing media, including playback restored away from zero. */
export const waitUntilPlaying = async (page: Page): Promise<void> => {
  await expect(page).toHaveURL(/\/web\/player$/u);
  const player = page.getByRole("region", { name: "Media player" });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const status = document.querySelector(".media-player")?.getAttribute("data-status");
        const video = document.querySelector("video");
        return (
          status === "blocked" ||
          (status === "ready" && video !== null && !video.paused && !video.seeking)
        );
      }),
    )
    .toBe(true);
  if ((await player.getAttribute("data-status")) === "blocked")
    await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(player).toHaveAttribute("data-status", "ready");
  const position = () => page.evaluate(() => document.querySelector("video")?.currentTime ?? 0);
  const before = await position();
  await expect.poll(position).toBeGreaterThan(before + 0.2);
};
