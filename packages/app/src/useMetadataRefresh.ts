import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useRuntime } from "./Runtime";
import { useWorkspace } from "./Workspace";

export type MetadataRefresh = "idle" | "running" | "succeeded" | "failed";

/** Follows a metadata refresh to its end, then reloads everything it may have changed. */
export const useMetadataRefresh = (runId: string | undefined): MetadataRefresh => {
  const runtime = useRuntime();
  const { scope } = useWorkspace();
  const client = useQueryClient();
  const refreshedRun = useRef<string | null>(null);
  const run = useQuery({
    queryKey: [...scope, "metadata-refresh", runId],
    queryFn: () => runtime.admin.scanStatus(runId ?? ""),
    enabled: runId !== undefined,
    refetchInterval: (query) =>
      query.state.data === undefined || ["queued", "running"].includes(query.state.data.status)
        ? 1_000
        : false,
  });
  const status = run.data?.status;
  const running = status === undefined || status === "queued" || status === "running";
  useEffect(() => {
    if (runId === undefined || running || refreshedRun.current === runId) return;
    refreshedRun.current = runId;
    void client.invalidateQueries({ queryKey: scope });
  }, [client, scope, running, runId]);
  if (runId === undefined) return "idle";
  if (run.isError || status === "failed" || status === "cancelled") return "failed";
  return running ? "running" : "succeeded";
};
