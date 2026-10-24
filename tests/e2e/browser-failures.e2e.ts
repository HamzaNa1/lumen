import { DatabaseSync } from "node:sqlite";
import { openMovie, pause, playing, signIn } from "./support/browser";
import { expect, test } from "./support/server";

for (const failure of ["invalid-media", "load-timeout", "network-error"] as const)
  test(`browser ${failure} ends visibly and releases the playback session`, async ({
    server,
    admin,
    page,
  }) => {
    const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
    await signIn(page, server);
    await page.clock.install();
    let requested = false;
    const release = Promise.withResolvers<void>();
    await page.route("**/api/v1/media/**", async (route) => {
      requested = true;
      if (failure === "load-timeout") {
        await release.promise;
        await route.abort().catch(() => {});
      } else if (failure === "network-error") await route.abort("connectionreset");
      else await route.fulfill({ status: 200, contentType: "video/mp4", body: "not a media file" });
    });
    try {
      await page.goto(`${server.origin}web/library/${library.id}`);
      await page
        .getByRole("button", { name: "Play Film", exact: true })
        .first()
        .click({ force: true });
      await expect.poll(() => requested).toBe(true);
      if (failure === "load-timeout") await page.clock.fastForward(20_001);
      await expect(page.getByText("Playback failed", { exact: true })).toBeVisible({
        timeout: 25_000,
      });
      const db = new DatabaseSync(server.databasePath, { readOnly: true });
      try {
        await expect
          .poll(
            () =>
              db
                .prepare(
                  "SELECT count(*) AS count FROM playback_sessions WHERE closed_at_ms IS NULL",
                )
                .get()?.count,
          )
          .toBe(0);
      } finally {
        db.close();
      }
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
    } finally {
      release.resolve();
    }
  });

test("autoplay refusal waits for a user gesture and then plays real media", async ({
  server,
  admin,
  page,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    let refused = false;
    HTMLMediaElement.prototype.play = function () {
      if (!refused) {
        refused = true;
        return Promise.reject(new DOMException("Gesture required", "NotAllowedError"));
      }
      return play.call(this);
    };
  });
  await signIn(page, server);
  await page.goto(`${server.origin}web/library/${library.id}`);
  await page.getByRole("button", { name: "Play Film", exact: true }).first().click({ force: true });
  await expect(page.getByRole("region", { name: "Media player" })).toHaveAttribute(
    "data-status",
    "blocked",
  );
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("region", { name: "Media player" })).toHaveAttribute(
    "data-status",
    "ready",
  );
  await playing(page);
});

test("navigation cancels a loading movie without letting its late network response overwrite the successor", async ({
  server,
  admin,
  page,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4", "Other.mp4"]);
  await signIn(page, server);
  let held = false;
  const release = Promise.withResolvers<void>();
  await page.route("**/api/v1/media/**", async (route) => {
    if (!held) {
      held = true;
      await release.promise;
    }
    await route.continue().catch(() => {});
  });
  try {
    await page.goto(`${server.origin}web/library/${library.id}`);
    await page
      .getByRole("button", { name: "Play Film", exact: true })
      .first()
      .click({ force: true });
    await expect.poll(() => held).toBe(true);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page
      .getByRole("button", { name: "Play Other", exact: true })
      .first()
      .click({ force: true });
    await playing(page);
    release.resolve();
    await expect(page.getByRole("region", { name: "Media player" })).toContainText("Other");
    const db = new DatabaseSync(server.databasePath, { readOnly: true });
    try {
      await expect
        .poll(
          () =>
            db
              .prepare("SELECT count(*) AS count FROM playback_sessions WHERE closed_at_ms IS NULL")
              .get()?.count,
        )
        .toBe(1);
    } finally {
      db.close();
    }
  } finally {
    release.resolve();
  }
});

test("a stalled progress save does not delay local pause and playback stops after saving", async ({
  server,
  admin,
  page,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  await signIn(page, server);
  await openMovie(page, server, library.id);
  let requested = false;
  const release = Promise.withResolvers<void>();
  await page.route("**/playback/sessions/*/progress", async (route) => {
    requested = true;
    await release.promise;
    await route.continue().catch(() => {});
  });
  try {
    await pause(page);
    await expect.poll(() => requested).toBe(true);
    release.resolve();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  } finally {
    release.resolve();
  }
});

test("expired playback is reopened after the tab resumes and retains its last position", async ({
  server,
  admin,
  page,
}) => {
  const library = await server.library(admin.accessToken, "movies", ["Film.mp4"]);
  await signIn(page, server);
  await page.clock.install();
  await openMovie(page, server, library.id);
  await pause(page);
  const db = new DatabaseSync(server.databasePath);
  try {
    const old = db.prepare("SELECT id FROM playback_sessions WHERE closed_at_ms IS NULL").get()?.id;
    db.exec(
      "UPDATE playback_sessions SET started_at_ms = 1, last_seen_at_ms = 1, expires_at_ms = 2 WHERE closed_at_ms IS NULL",
    );
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
    );
    await page.clock.fastForward(21_000);
    await expect
      .poll(
        () =>
          db
            .prepare(
              "SELECT id FROM playback_sessions WHERE closed_at_ms IS NULL AND expires_at_ms > ?",
            )
            .get(Date.now())?.id,
      )
      .toEqual(expect.any(String));
    expect(
      db
        .prepare(
          "SELECT id FROM playback_sessions WHERE closed_at_ms IS NULL AND expires_at_ms > ?",
        )
        .get(Date.now())?.id,
    ).not.toBe(old);
    await expect(page.getByRole("region", { name: "Media player" })).toHaveAttribute(
      "data-status",
      "ready",
    );
  } finally {
    db.close();
  }
});
