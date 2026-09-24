import { CircleAlert, LoaderCircle } from "lucide-react";

export const StatusState = ({
  title,
  message,
  action,
  loading = false,
}: {
  readonly title: string;
  readonly message: string;
  readonly action?: React.ReactNode;
  readonly loading?: boolean;
}): React.ReactElement => (
  <section className="status-state" role="status">
    <span className={`status-icon${loading ? " loading" : ""}`}>
      {loading ? (
        <LoaderCircle aria-hidden="true" size={22} />
      ) : (
        <CircleAlert aria-hidden="true" size={22} />
      )}
    </span>
    <h2>{title}</h2>
    <p>{message}</p>
    {action}
  </section>
);
