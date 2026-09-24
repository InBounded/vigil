import type { ShownError } from "../analysis/errors.js";
import { useMessages } from "../i18n/locale.js";

/** An analysis that produced no report: says so plainly, never as a result. */
export function ErrorPanel({
  error,
  onRetry,
}: {
  readonly error: ShownError;
  readonly onRetry: () => void;
}) {
  const { m } = useMessages();
  return (
    <section className="panel panel-error" role="alert">
      <h1>{m("error.title")}</h1>
      <p>{m(error.key, error.params)}</p>
      <button type="button" className="button" onClick={onRetry}>
        {m("error.retry")}
      </button>
    </section>
  );
}
