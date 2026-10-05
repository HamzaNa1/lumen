import "@lumen/ui/styles/global.css";
import { LumenApp } from "@lumen/app";
import { createBrowserHistory } from "@tanstack/history";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRuntime } from "./browserRuntime";
import { UpdatePrompt } from "./UpdatePrompt";

const root = document.getElementById("root");
if (root === null) throw new Error("Application root is missing");
const runtime = createBrowserRuntime();
// The address the server serves this app from, without the trailing slash Vite's base carries.
const basepath = import.meta.env.BASE_URL.replace(/\/$/u, "");

createRoot(root).render(
  <StrictMode>
    <LumenApp runtime={runtime} history={createBrowserHistory()} basepath={basepath} />
    <UpdatePrompt api={runtime.api} />
  </StrictMode>,
);
