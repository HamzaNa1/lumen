import { expect, test } from "@playwright/test";
import {
  repaint,
  newSignedOutPage,
  gotoDesktop,
  settled,
  expectAlike,
  expectDesktopUnchanged,
  signedInBuilds,
} from "./desktopRenderer";

// The same flows compare the immutable desktop baseline for releases, and additionally
// compare the two current products in source CI. Desktop mode never navigates to the web app.
export const desktopScenarios = ({ includeWeb }: { includeWeb: boolean }): void => {
  test(
    includeWeb
      ? "the desktop and web builds draw the shared pages identically"
      : "desktop pages and account menus retain their baseline behavior",
    async ({ context, baseURL }, testInfo) => {
      const builds = await signedInBuilds(context, baseURL ?? "");
      const { web, desktop } = builds;
      const libraries = (await (await context.request.get("/api/v1/libraries")).json()) as {
        id: string;
      }[];
      const libraryId = libraries[0]?.id ?? "";
      const items = (await (
        await context.request.get(`/api/v1/items?libraryId=${libraryId}&limit=50`)
      ).json()) as { items: { id: string; title: string }[] };
      const film = items.items.find((item) => item.title === "Film")?.id ?? "";
      expect(film).not.toBe("");

      const routes = [
        ["home", "/"],
        ["library index", "/library"],
        ["library", `/library/${libraryId}`],
        ["movie details", `/item/${film}`],
        ["search", "/search?q=Film"],
        ["settings", "/settings"],
        ["administration", "/admin"],
        ["users", "/admin/users"],
        ["job log", "/admin/jobs"],
      ] as const;

      for (const [name, route] of routes) {
        if (includeWeb) await web.page.goto(`/web${route}`);
        for (const { page, files } of builds.desktops) await gotoDesktop(page, files, route);
        if (includeWeb) await settled(web.page);
        for (const { page } of builds.desktops) await settled(page);
        // Every router must have ended up in the same place, including after any redirect.
        const expectedRoute = includeWeb
          ? await web.page.evaluate(() =>
              (location.pathname + location.search).replace(/^\/web/u, ""),
            )
          : await desktop.page.evaluate(() => window.location.hash.slice(1));
        for (const { page } of builds.desktops)
          await expect
            .poll(() => page.evaluate(() => window.location.hash.slice(1)))
            .toBe(expectedRoute);

        // Navigation is shared; the account menu beneath it differs by design and is left out.
        if (includeWeb) await expectAlike(testInfo, name, ".nav", [web, desktop]);
        // The users page has listed each account's libraries only since the baseline was taken, and
        // settings has traded the rows that only reported things for playback preferences since then.
        // Movies have had a settings button only since the baseline was taken, and the baseline
        // still gives the fixture film, too short to have a runtime, one of "0m".
        if (name !== "users" && name !== "settings")
          await expectDesktopUnchanged(
            testInfo,
            name,
            builds,
            name === "movie details"
              ? { style: ".details-icon-button, .details-meta { display: none !important; }" }
              : undefined,
          );
        if (name !== "settings") {
          if (includeWeb) await expectAlike(testInfo, name, ".main-content", [web, desktop]);
          continue;
        }
        // Settings is the one page meant to differ: only the desktop can switch servers, so only its
        // card continues below the server. Everything above that must still be drawn the same.
        if (includeWeb) {
          for (const row of ["Preferred audio", "Preferred subtitles"])
            await expectAlike(
              testInfo,
              `settings ${row}`,
              (page) => page.locator(".settings-row").filter({ hasText: row }),
              [web, desktop],
            );
          await expectAlike(
            testInfo,
            "settings server",
            (page) => page.getByRole("region", { name: "Server" }).locator(".settings-row-text"),
            [web, desktop],
          );
        }
        for (const { page } of includeWeb ? [web, desktop] : [desktop]) {
          await expect(page.getByRole("combobox", { name: "Preferred audio language" })).toHaveText(
            "English",
          );
          await expect(page.getByRole("combobox", { name: "Preferred subtitles" })).toHaveText(
            "Off",
          );
        }
        await expect(desktop.page.getByRole("button", { name: "Switch server…" })).toBeVisible();
        if (includeWeb)
          await expect(web.page.getByRole("button", { name: "Switch server…" })).toHaveCount(0);
      }

      // The account menu lists servers only where servers can be switched, so the web build's is
      // shorter by design; the desktop's must be what it was.
      for (const { page } of includeWeb ? [web, ...builds.desktops] : builds.desktops) {
        await page.locator(".account-trigger").click();
        await expect(page.locator(".account-menu")).toBeVisible();
      }
      if (includeWeb) {
        await expectAlike(testInfo, "account trigger", ".account-trigger", [web, desktop]);
        await expectAlike(testInfo, "shared account menu", ".account-menu", [web, desktop], {
          style:
            ".account-menu > [role='group'], .account-menu > .menu-separator, .account-menu > .menu-item:has(.lucide-plus) { display: none !important; }",
        });
        await expect(web.page.getByRole("menuitem", { name: "Add server…" })).toHaveCount(0);
      }
      await expect(desktop.page.getByRole("menuitem", { name: "Add server…" })).toBeVisible();
      await expectDesktopUnchanged(testInfo, "account menu", builds);
    },
  );

  test("the connection forms are drawn identically", async ({
    browser,
    context,
    baseURL,
  }, testInfo) => {
    const builds = await signedInBuilds(context, baseURL ?? "");
    const { desktop } = builds;
    // The web build signs in to the server it was loaded from, so it has no address form.
    for (const { page, files } of builds.desktops) {
      await gotoDesktop(page, files, "/", { signedOut: true });
      await settled(page, ".connect-form");
    }
    // The baseline still asks the viewer to name the server, which now names itself.
    await expectDesktopUnchanged(testInfo, "server address form", builds, {
      style: '.connect-form > :has(input[placeholder="Living room"]) { display: none !important; }',
    });

    for (const { page } of builds.desktops) {
      await page.getByLabel("Server address").fill(baseURL ?? "");
      await page.getByRole("button", { name: "Continue" }).click();
      // The button sits higher without the baseline's name field, so the pointer it leaves
      // behind would rest on a different part of the next form in each build.
      await page.mouse.move(0, 0);
      await page.getByLabel("Username").focus();
    }
    // The baseline still offers to create an account on a server that is already set up, and
    // shows the name typed on the device where the server's own name now appears.
    await expectDesktopUnchanged(testInfo, "sign-in form", builds, {
      style:
        ".connect-switch { display: none !important; } .server-chip strong, .connect-heading p { visibility: hidden !important; }",
    });

    if (!includeWeb) return;
    const signedOut = await newSignedOutPage(browser, baseURL ?? "");
    try {
      const web = { build: "web", page: signedOut };
      await signedOut.goto("/web/");
      await settled(signedOut, ".connect-form");
      await signedOut.getByLabel("Username").focus();
      // Only the desktop offers to change the server.
      const style = ".server-chip { visibility: hidden !important; }";
      await expectAlike(testInfo, "sign-in form", ".connect-form", [web, desktop], { style });
      await expect(signedOut.getByRole("button", { name: "Create an account" })).toHaveCount(0);
    } finally {
      await signedOut.context().close();
    }
  });

  test("watch groups are drawn identically", async ({ context, baseURL }, testInfo) => {
    const builds = await signedInBuilds(context, baseURL ?? "");
    const { web, desktop } = builds;
    const pages = (includeWeb ? [web, ...builds.desktops] : builds.desktops).map(
      (side) => side.page,
    );
    if (includeWeb) await web.page.goto("/web/");
    for (const { page, files } of builds.desktops) await gotoDesktop(page, files, "/");
    for (const page of pages) await settled(page);

    const compare = async (name: string): Promise<void> => {
      // A control that appears under a pointer left where it last clicked may or may not be
      // drawn as hovered, so the pointer is moved off the panel first.
      for (const page of pages) await page.mouse.move(700, 300);
      // The sidebar redraws in pieces as a group comes and goes, and not in the same pieces in
      // every build.
      for (const page of pages) await repaint(page, ".sidebar");
      if (includeWeb) {
        await expectAlike(testInfo, name, ".watch-group-panel", [web, desktop]);
        await expectAlike(testInfo, name, ".watch-group-trigger", [web, desktop]);
      }
      await expectDesktopUnchanged(testInfo, name, builds);
    };

    for (const page of pages) {
      await page.locator(".watch-group-trigger").click();
      await expect(page.getByText("No groups yet")).toBeVisible();
    }
    await compare("no watch groups");

    for (const page of pages) {
      await page.getByRole("button", { name: "New group" }).click();
      await page.getByLabel("Name").fill("Movie night");
      await page.getByLabel("Password").fill("together");
    }
    await compare("new watch group form");

    // Each build starts a group of its own, so each sees one member: itself.
    for (const page of pages) {
      await page.getByRole("button", { name: "Create group" }).click();
      await expect(page.getByText("1 person")).toBeVisible();
    }
    await compare("active watch group");

    for (const page of pages) await page.getByRole("button", { name: "Leave" }).click();
    // The other builds' groups disappear from the list as they leave too.
    for (const page of pages) await expect(page.getByText("No groups yet")).toBeVisible();
    await compare("left watch group");
  });
};
