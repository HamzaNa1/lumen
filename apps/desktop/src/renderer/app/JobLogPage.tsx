import type { JobLogEntry } from "@lumen/contracts";
import { Button, EmptyState, SegmentedControl, StatusState } from "@lumen/ui";
import { useQuery } from "@tanstack/react-query";
import { Activity, ChevronRight, RefreshCw } from "lucide-react";
import { useState } from "react";
import { AdminOnly } from "./AdminPages";
import {
  formatElapsed,
  formatJobDate,
  formatRelative,
  jobErrorText,
  jobStatusLabels,
  plural,
  shortId,
} from "./format";
import { bridge, PageHeader, useWorkspace } from "./Workspace";

type RunStatus = JobLogEntry["status"];
type StatusFilter = "all" | "active" | "failed" | "succeeded" | "cancelled";

interface ScanRunSummary {
  readonly runId: string;
  readonly libraryName: string;
  readonly mode: JobLogEntry["mode"];
  readonly status: RunStatus;
  readonly jobs: ReadonlyArray<JobLogEntry>;
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
  readonly failedCount: number;
}

const modeLabels: Record<JobLogEntry["mode"], string> = {
  full: "Full scan",
  incremental: "Incremental scan",
  refresh: "Metadata refresh",
};

const operationLabels: Record<JobLogEntry["operation"], string> = {
  discover: "Discover files",
  probe: "Read media info",
  artwork: "Fetch artwork",
  metadata: "Fetch metadata",
  analyze: "Analyze",
  cleanup: "Clean up",
};

const runStatus = (jobs: ReadonlyArray<JobLogEntry>): RunStatus => {
  if (jobs.some((job) => job.status === "running")) return "running";
  if (jobs.some((job) => job.status === "queued")) return "queued";
  if (jobs.some((job) => job.status === "failed")) return "failed";
  if (jobs.every((job) => job.status === "cancelled")) return "cancelled";
  return "succeeded";
};

const summarizeRuns = (entries: ReadonlyArray<JobLogEntry>): ReadonlyArray<ScanRunSummary> => {
  const byRun = new Map<string, JobLogEntry[]>();
  for (const entry of entries) {
    const jobs = byRun.get(entry.runId);
    if (jobs === undefined) byRun.set(entry.runId, [entry]);
    else jobs.push(entry);
  }
  return [...byRun.entries()]
    .map(([runId, jobs]) => {
      const status = runStatus(jobs);
      const finished = jobs.map((job) => job.finishedAtMs).filter((value) => value !== null);
      return {
        runId,
        libraryName: jobs[0]?.libraryName ?? "Unknown library",
        mode: jobs[0]?.mode ?? "full",
        status,
        jobs: [...jobs].sort(
          (left, right) =>
            (left.startedAtMs ?? left.availableAtMs) - (right.startedAtMs ?? right.availableAtMs),
        ),
        startedAtMs: Math.min(...jobs.map((job) => job.startedAtMs ?? job.availableAtMs)),
        finishedAtMs:
          status === "running" || status === "queued" || finished.length === 0
            ? null
            : Math.max(...finished),
        failedCount: jobs.filter((job) => job.status === "failed").length,
      };
    })
    .sort((left, right) => right.startedAtMs - left.startedAtMs);
};

const matchesFilter = (status: RunStatus, filter: StatusFilter): boolean =>
  filter === "all" ||
  (filter === "active" ? status === "running" || status === "queued" : status === filter);

const StatusBadge = ({ status }: { readonly status: RunStatus }): React.ReactElement => (
  <span className="job-status" data-status={status}>
    {jobStatusLabels[status]}
  </span>
);

const StartedAt = ({ milliseconds }: { readonly milliseconds: number }): React.ReactElement => (
  <time dateTime={new Date(milliseconds).toISOString()} title={formatJobDate(milliseconds)}>
    {formatRelative(milliseconds)}
  </time>
);

const RunRows = ({ run }: { readonly run: ScanRunSummary }): React.ReactElement => {
  const [expanded, setExpanded] = useState(false);
  const firstError = run.jobs.map(jobErrorText).find((error) => error !== null) ?? null;
  return (
    <>
      <tr className={`job-run${expanded ? " is-expanded" : ""}`}>
        <td>
          <button
            className="job-run-toggle"
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronRight aria-hidden="true" size={15} className="job-run-chevron" />
            <span className="job-run-name">
              <strong>{modeLabels[run.mode]}</strong>
              <span>{shortId(run.runId)}</span>
            </span>
          </button>
          {expanded || firstError === null ? null : (
            <p className="job-error" title={firstError}>
              {firstError}
            </p>
          )}
        </td>
        <td>{run.libraryName}</td>
        <td>
          <StatusBadge status={run.status} />
        </td>
        <td className="cell-numeric">
          {plural(run.jobs.length, "job")}
          {run.failedCount > 0 ? (
            <span className="job-failed-count"> · {run.failedCount} failed</span>
          ) : null}
        </td>
        <td className="cell-muted">
          <StartedAt milliseconds={run.startedAtMs} />
        </td>
        <td className="cell-numeric cell-muted">
          {formatElapsed(run.startedAtMs, run.finishedAtMs)}
        </td>
      </tr>
      {expanded
        ? run.jobs.map((job) => {
            const error = jobErrorText(job);
            return (
              <tr className="job-detail" key={job.id}>
                <td>
                  <span className="job-detail-name">
                    {operationLabels[job.operation]}
                    {error === null ? null : (
                      <span className="job-error" title={error}>
                        {error}
                      </span>
                    )}
                  </span>
                </td>
                <td className="cell-muted">
                  Attempt {job.attempts} of {job.maxAttempts}
                </td>
                <td>
                  <StatusBadge status={job.status} />
                </td>
                <td />
                <td className="cell-muted">
                  {job.startedAtMs !== null ? (
                    <StartedAt milliseconds={job.startedAtMs} />
                  ) : job.status === "queued" ? (
                    "Waiting"
                  ) : (
                    "—"
                  )}
                </td>
                <td className="cell-numeric cell-muted">
                  {formatElapsed(job.startedAtMs, job.finishedAtMs)}
                </td>
              </tr>
            );
          })
        : null}
    </>
  );
};

export const JobLogPage = (): React.ReactElement => (
  <AdminOnly>
    <JobLog />
  </AdminOnly>
);

const JobLog = (): React.ReactElement => {
  const { scope } = useWorkspace();
  const [filter, setFilter] = useState<StatusFilter>("all");
  const jobs = useQuery({
    queryKey: [...scope, "admin", "jobs"],
    queryFn: () => bridge.admin.jobLog(),
    refetchInterval: 5_000,
  });
  const runs = summarizeRuns(jobs.data ?? []);
  const visible = runs.filter((run) => matchesFilter(run.status, filter));
  const count = (value: StatusFilter): number =>
    runs.filter((run) => matchesFilter(run.status, value)).length;
  const cancelled = count("cancelled");
  return (
    <div className="page">
      <PageHeader
        title="Job log"
        subtitle="Library scans and background work on this server. Updates every few seconds."
        actions={
          <Button onClick={() => void jobs.refetch()} disabled={jobs.isFetching}>
            <RefreshCw
              aria-hidden="true"
              className={jobs.isFetching ? "spinner" : undefined}
              size={15}
            />
            Refresh
          </Button>
        }
      />
      {jobs.isLoading ? (
        <div className="panel-skeleton" aria-hidden="true" />
      ) : jobs.isError ? (
        <StatusState
          title="Couldn’t load the job log"
          message="The server’s recent jobs could not be loaded."
          action={<Button onClick={() => void jobs.refetch()}>Try again</Button>}
        />
      ) : runs.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No jobs yet"
          message="Library scans and metadata refreshes will show up here."
        />
      ) : (
        <>
          <div className="toolbar">
            <SegmentedControl
              label="Filter by status"
              value={filter}
              onValueChange={setFilter}
              options={[
                { value: "all", label: "All", count: runs.length },
                { value: "active", label: "Active", count: count("active") },
                { value: "failed", label: "Failed", count: count("failed") },
                { value: "succeeded", label: "Succeeded", count: count("succeeded") },
                ...(cancelled > 0 || filter === "cancelled"
                  ? [{ value: "cancelled" as const, label: "Cancelled", count: cancelled }]
                  : []),
              ]}
            />
            <span className="toolbar-note">
              {plural(jobs.data?.length ?? 0, "job")} across {plural(runs.length, "run")}
            </span>
          </div>
          <div className="panel table-panel">
            {visible.length === 0 ? (
              <p className="table-empty">No runs match this filter.</p>
            ) : (
              <table className="data-table job-table">
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col">Library</th>
                    <th scope="col">Status</th>
                    <th scope="col">Jobs</th>
                    <th scope="col">Started</th>
                    <th scope="col">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((run) => (
                    <RunRows key={run.runId} run={run} />
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
};
