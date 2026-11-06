import { useEffect, useState } from "react";

export function navigate(to: string) {
  if (to === location.pathname + location.search) return;
  history.pushState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

/** Change the URL without a route change (e.g. a new chat got its id). */
export function replaceUrl(to: string) {
  history.replaceState(null, "", to);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function useLocation() {
  const [loc, setLoc] = useState(() => ({ path: location.pathname, search: location.search }));
  useEffect(() => {
    const on = () => setLoc({ path: location.pathname, search: location.search });
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return loc;
}
