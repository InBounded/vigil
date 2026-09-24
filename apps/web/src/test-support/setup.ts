import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom does not implement scrolling (it logs "Not implemented"); the app only scrolls to the top
// on navigation, which has nothing to verify without a layout.
globalThis.scrollTo = () => undefined;

// Testing Library only cleans up automatically when Vitest globals are on; they are not here.
afterEach(() => {
  cleanup();
});
