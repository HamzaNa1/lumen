import { createHashHistory } from "@tanstack/history";
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AdminPage, App, HomePage, LibraryPage, SearchPage, SettingsPage } from "./App";

const rootRoute = createRootRoute({ component: App });
const homeRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: HomePage });
const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library",
  component: LibraryPage,
});
const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/search",
  component: SearchPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});
const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin",
  component: AdminPage,
});

const routeTree = rootRoute.addChildren([
  homeRoute,
  libraryRoute,
  searchRoute,
  settingsRoute,
  adminRoute,
]);

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
