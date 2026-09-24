import type { ReactNode } from "react";

export const Shell = ({
  sidebar,
  children,
}: {
  readonly sidebar: ReactNode;
  readonly children: ReactNode;
}): React.ReactElement => (
  <div className="app-shell">
    <aside className="sidebar">{sidebar}</aside>
    <main className="main-content">{children}</main>
  </div>
);
