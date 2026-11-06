import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import Explore from "./Explore.tsx";
import { useLocation } from "./router.ts";
import "./styles.css";

function Root() {
  const { path, search } = useLocation();
  if (path.startsWith("/explore")) return <Explore />;
  return <App chatId={new URLSearchParams(search).get("chat") ?? undefined} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
