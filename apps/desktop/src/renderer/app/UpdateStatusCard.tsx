import type { IpcUpdateState } from "@lumen/contracts";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";

export const UpdateStatusCard = (): React.ReactElement => {
  const [state, setState] = useState<IpcUpdateState | null>(null);
  useEffect(() => {
    let mounted = true;
    const accept = (next: IpcUpdateState): void => {
      if (!mounted) return;
      setState((current) => current === null || next.revision >= current.revision ? next : current);
    };
    const unsubscribe = window.lumen.updates.onState(accept);
    void window.lumen.updates.state().then(accept).catch(() => undefined);
    return () => { mounted = false; unsubscribe(); };
  }, []);

  const detail = state === null ? "Loading update status…" :
    state.phase === "ready" ? state.message :
    state.phase === "downloading" ? `Downloading ${state.availableVersion ?? "update"}${state.progressPercent === null ? "" : `: ${Math.round(state.progressPercent)}%`}` :
    state.phase === "checking" ? "Checking for updates…" :
    state.phase === "idle" ? "Lumen checks for updates automatically." :
    state.message;
  return (
    <section className="info-card" aria-live="polite">
      <div className="panel-heading">
        <span className="panel-icon"><RefreshCw aria-hidden="true" size={19} /></span>
        <h2>Updates</h2>
      </div>
      <div className="info-rows">
        <div><span>Current version</span><strong>{state?.currentVersion ?? "…"}</strong></div>
        <div><span>Status</span><strong>{detail}</strong></div>
      </div>
    </section>
  );
};
