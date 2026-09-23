export const StatusState = ({ title, message, action }: { readonly title: string; readonly message: string; readonly action?: React.ReactNode }): React.ReactElement => (
  <section className="status-state" role="status">
    <h2>{title}</h2>
    <p>{message}</p>
    {action}
  </section>
);
