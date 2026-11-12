import "@lumen/ui/styles/global.css";
import { AppProviders, LumenApp } from "@lumen/app";
import { createHashHistory } from "@tanstack/history";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createDesktopRuntime } from "../desktopRuntime";
import { PlayerOverlay } from "./PlayerOverlay";

const root = document.getElementById("root");
if (root === null) throw new Error("Renderer root is missing");
const bridge = window.lumen;
const runtime = createDesktopRuntime(bridge);
const isOverlay = new URLSearchParams(window.location.search).has("overlay");
if (isOverlay) document.documentElement.classList.add("overlay-window");
createRoot(root).render(
  <StrictMode>
    {isOverlay ? (
      <AppProviders runtime={runtime}>
        <PlayerOverlay bridge={bridge} />
      </AppProviders>
    ) : (
      <LumenApp runtime={runtime} history={createHashHistory()} />
    )}
  </StrictMode>,
);
