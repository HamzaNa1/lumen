import { createHashHistory } from "@tanstack/history";
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AdminLibrariesPage, AdminUsersPage } from "./AdminPages";
import { App } from "./App";
import { HomePage, LibraryIndexPage, LibraryPage, SearchPage } from "./BrowsePages";
import { EpisodePage, ItemPage, SeasonPage, ShowPage } from "./ItemPages";
import { JobLogPage } from "./JobLogPage";
import { PlayerPage } from "./PlayerPage";
import { SettingsPage } from "./SettingsPage";

const rootRoute = createRootRoute({ component: App });
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage });
const libraryIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library",
  component: LibraryIndexPage,
});
const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/$libraryId",
  component: LibraryPage,
});
const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/search",
  validateSearch: (search: Record<string, unknown>): { q?: string } =>
    typeof search.q === "string" && search.q !== "" ? { q: search.q } : {},
  component: SearchPage,
});
// Movies and other standalone titles share one page; each level of a series has its own.
const itemRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/item/$itemId",
  component: ItemPage,
});
const showRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/show/$itemId",
  component: ShowPage,
});
const seasonRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/season/$itemId",
  component: SeasonPage,
});
const episodeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/episode/$itemId",
  component: EpisodePage,
});
const playerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/player",
  component: PlayerPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: AdminLibrariesPage,
});
const adminUsersRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/users",
  component: AdminUsersPage,
});
const jobLogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/jobs",
  component: JobLogPage,
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  libraryIndexRoute,
  libraryRoute,
  searchRoute,
  itemRoute,
  showRoute,
  seasonRoute,
  episodeRoute,
  playerRoute,
  settingsRoute,
  adminRoute,
  adminUsersRoute,
  jobLogRoute,
]);

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: "intent",
  scrollRestoration: true,
  // Pages scroll inside the shell, not the window: start new pages at the top and let
  // Back restore where the viewer was.
  scrollToTopSelectors: [".main-content"],
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
