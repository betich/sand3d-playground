import type { ReactNode } from "react";
import { navigate } from "./router.ts";

export default function TopBar({ page, children }: { page: "playground" | "collection"; children?: ReactNode }) {
  const link = (to: string, name: typeof page, label: string) => (
    <a
      href={to}
      className={page === name ? "nav on" : "nav"}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {label}
    </a>
  );
  return (
    <header className="top">
      <div className="top-left">
        <h1 className="brand">sand3d</h1>
        <nav className="navs">
          {link("/", "playground", "Playground")}
          {link("/explore", "collection", "Collection")}
        </nav>
      </div>
      <div className="top-meta">
        <a href="https://sand3d.sandflow.ai/api.html" target="_blank" rel="noreferrer">
          API ↗
        </a>
        <a href="https://github.com/Sandflow-ai/sand3d" target="_blank" rel="noreferrer">
          Repo ↗
        </a>
        {children}
      </div>
    </header>
  );
}
