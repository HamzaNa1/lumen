import type { ReactNode } from "react";

export const Shell = ({ sidebar, children, player }: { readonly sidebar: ReactNode; readonly children: ReactNode; readonly player?: ReactNode }): React.ReactElement => (
  <div className="app-shell">
    <aside className="sidebar">{sidebar}</aside>
    <main className="main-content">{children}</main>
    {player === undefined ? null : <footer className="player-bar">{player}</footer>}
  </div>
);
