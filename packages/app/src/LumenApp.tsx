import type { LumenRuntime } from "@lumen/client/runtime";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { type AppRouterOptions, createAppRouter } from "./router";
import { RuntimeProvider } from "./Runtime";

/**
 * Reads may be retried once; a request cancelled because its session ended is never repeated.
 * Mutations are not retried at all: one that failed in transit may already have taken effect.
 */
export const createQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: (failureCount, error) => failureCount < 1 && error.name !== "RequestCancelledError",
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });

/** Supplies the runtime and a query cache to a tree that is not the routed application. */
export const AppProviders = ({
  runtime,
  children,
}: {
  readonly runtime: LumenRuntime;
  readonly children: ReactNode;
}): React.ReactElement => {
  const [queryClient] = useState(createQueryClient);
  return (
    <RuntimeProvider runtime={runtime}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </RuntimeProvider>
  );
};

/**
 * The whole application for one root. Its router and query cache are created here, so each root
 * starts with its own navigation state and an empty cache.
 */
export const LumenApp = ({
  runtime,
  history,
  basepath,
}: AppRouterOptions & { readonly runtime: LumenRuntime }): React.ReactElement => {
  const [router] = useState(() => createAppRouter({ history, basepath }));
  return (
    <AppProviders runtime={runtime}>
      <RouterProvider router={router} />
    </AppProviders>
  );
};
