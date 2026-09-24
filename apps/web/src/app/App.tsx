import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useMessages } from "../i18n/locale.js";
import { parseRoute, type Route } from "../lib/routes.js";
import HomeScreen from "../screens/HomeScreen.js";

// Everything that needs the analysis engine is its own chunk: the start page loads without it.
const ReportScreen = lazy(() => import("../screens/ReportScreen.js"));
const MultisigScreen = lazy(() => import("../screens/MultisigScreen.js"));
const SettingsScreen = lazy(() => import("../screens/SettingsScreen.js"));
const AboutScreen = lazy(() => import("../screens/AboutScreen.js"));

function currentHash(): string {
  return globalThis.location?.hash ?? "";
}

/** Layout (skip link, header navigation, main, footer) and hash routing. */
export function App() {
  const { m } = useMessages();
  const [route, setRoute] = useState<Route>(() => parseRoute(currentHash()));
  const main = useRef<HTMLElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(currentHash()));
    globalThis.addEventListener("hashchange", onChange);
    return () => globalThis.removeEventListener("hashchange", onChange);
  }, []);
  // Move focus to the new page's content on navigation (not on the first load).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (route.name !== "not-found") {
      main.current?.focus({ preventScroll: true });
      globalThis.scrollTo?.(0, 0);
    }
  }, [route]);
  const navigate = useCallback((hash: string) => {
    globalThis.location.hash = hash;
  }, []);
  const current = route.name;
  return (
    <>
      {/* A button, not an `#main` link: the fragment is the router's. */}
      <button type="button" className="skip-link" onClick={() => main.current?.focus()}>
        {m("nav.skip")}
      </button>
      <header className="site-header">
        <a className="brand" href="#/">
          <span aria-hidden="true" className="brand-mark">
            ◉
          </span>{" "}
          {m("app.name")}
        </a>
        <nav aria-label={m("nav.main")}>
          <ul className="nav-list">
            <li>
              <a href="#/" aria-current={current === "home" ? "page" : undefined}>
                {m("nav.home")}
              </a>
            </li>
            <li>
              <a href="#/settings" aria-current={current === "settings" ? "page" : undefined}>
                {m("nav.settings")}
              </a>
            </li>
            <li>
              <a href="#/about" aria-current={current === "about" ? "page" : undefined}>
                {m("nav.about")}
              </a>
            </li>
          </ul>
        </nav>
      </header>
      <main id="main" ref={main} tabIndex={-1}>
        <Suspense
          fallback={
            <p className="loading" role="status">
              {m("loading")}
            </p>
          }
        >
          <Screen route={route} navigate={navigate} />
        </Suspense>
      </main>
      <footer className="site-footer">
        <p>{m("app.tagline")}</p>
        <p>{m("home.notes.1")}</p>
      </footer>
    </>
  );
}

function Screen({
  route,
  navigate,
}: {
  readonly route: Route;
  readonly navigate: (hash: string) => void;
}) {
  const { m } = useMessages();
  switch (route.name) {
    case "home":
      return <HomeScreen navigate={navigate} />;
    case "multisig":
      return <MultisigScreen key={`${route.cluster}:${route.multisig}`} route={route} />;
    case "proposal":
    case "transaction":
      return <ReportScreen route={route} />;
    case "settings":
      return <SettingsScreen />;
    case "about":
      return <AboutScreen />;
    case "not-found":
      return (
        <section className="panel">
          <h1>{m("notFound")}</h1>
          <p>
            <a href="#/">{m("notFound.home")}</a>
          </p>
        </section>
      );
  }
}
