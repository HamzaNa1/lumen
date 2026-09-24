import "@lumen/ui/styles/global.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PlayerOverlay } from "./PlayerOverlay";
import { router } from "./router";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, gcTime: 5 * 60_000, retry: 1, refetchOnWindowFocus: false },
  },
});

const root = document.getElementById("root");
if (root === null) throw new Error("Renderer root is missing");
const isOverlay = new URLSearchParams(window.location.search).has("overlay");
if (isOverlay) document.documentElement.classList.add("overlay-window");
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {isOverlay ? <PlayerOverlay /> : <RouterProvider router={router} />}
    </QueryClientProvider>
  </StrictMode>,
);
