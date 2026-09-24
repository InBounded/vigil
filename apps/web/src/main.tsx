import { createRoot } from "react-dom/client";
import { Root } from "./app/Root.js";
import { browserEnvironment } from "./env/browser.js";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("index.html has no #root element");
}
createRoot(container).render(<Root environment={browserEnvironment()} />);
