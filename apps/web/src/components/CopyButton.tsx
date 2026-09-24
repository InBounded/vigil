import { useState } from "react";
import { useEnvironment } from "../env/context.js";

type CopyState = "idle" | "copied" | "failed";

/** Copies `text`; the result is announced to screen readers and shown next to the button. */
export function CopyButton({
  text,
  label,
  copiedLabel,
  failedLabel,
  className,
}: {
  readonly text: string;
  readonly label: string;
  readonly copiedLabel: string;
  readonly failedLabel: string;
  readonly className?: string;
}) {
  const { writeClipboard } = useEnvironment();
  const [state, setState] = useState<CopyState>("idle");
  const copy = () => {
    writeClipboard(text).then(
      () => setState("copied"),
      () => setState("failed"),
    );
  };
  return (
    <span className="copy">
      <button type="button" className={className ?? "button-small"} onClick={copy}>
        {label}
      </button>
      <span className="copy-status" role="status">
        {state === "copied" ? copiedLabel : state === "failed" ? failedLabel : ""}
      </span>
    </span>
  );
}
