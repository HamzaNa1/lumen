import { expect, type Page } from "@playwright/test";

export const PROFILE = 'video/mp4; codecs="avc1.64001e,mp4a.40.2"';
export const capabilities = (page: Page) =>
  page.evaluate(
    (profile) => ({
      managed: typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(profile),
      direct: document.createElement("video").canPlayType(profile) !== "",
    }),
    PROFILE,
  );

export const selectDelivery = async (page: Page, value: "auto" | "direct" | "managed") => {
  await page.goto("/web/settings");
  await page.getByLabel("Browser delivery").selectOption(value);
};

export const startFilm = async (page: Page, title = "Long film") => {
  await page.goto("/web/library");
  await page
    .getByRole("button", { name: `Play ${title}`, exact: true })
    .first()
    .click({ force: true });
  await expect(page).toHaveURL(/\/web\/player$/u);
};

export const loaded = async (page: Page) => {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const video = document.querySelector("video");
          return video !== null && Number.isFinite(video.duration) && video.readyState >= 2;
        }),
      { timeout: 15_000 },
    )
    .toBe(true);
};

export const buffer = (page: Page) =>
  page.evaluate(() => {
    const video = document.querySelector("video");
    if (video === null) throw new Error("Missing video");
    return {
      position: video.currentTime,
      paused: video.paused,
      ranges: Array.from({ length: video.buffered.length }, (_, index) => [
        video.buffered.start(index),
        video.buffered.end(index),
      ]),
    };
  });
