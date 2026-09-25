import { CircleAlert, LoaderCircle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export const StatusState = ({
  title,
  message,
  action,
  loading = false,
}: {
  readonly title: string;
  readonly message?: string;
  readonly action?: ReactNode;
  readonly loading?: boolean;
}): React.ReactElement => (
  <section className={`status-state${loading ? " is-loading" : ""}`} role="status">
    {loading ? (
      <LoaderCircle className="spinner" aria-hidden="true" size={20} />
    ) : (
      <CircleAlert aria-hidden="true" size={20} />
    )}
    <h2>{title}</h2>
    {message === undefined ? null : <p>{message}</p>}
    {action === undefined ? null : <div className="status-state-action">{action}</div>}
  </section>
);

export const EmptyState = ({
  icon: Icon,
  title,
  message,
  action,
}: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly message?: string;
  readonly action?: ReactNode;
}): React.ReactElement => (
  <div className="empty-state">
    <Icon aria-hidden="true" size={28} strokeWidth={1.5} />
    <h3>{title}</h3>
    {message === undefined ? null : <p>{message}</p>}
    {action === undefined ? null : <div className="empty-state-action">{action}</div>}
  </div>
);
