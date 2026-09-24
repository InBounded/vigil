import type { ShownError } from "../analysis/errors.js";
import { useMessages } from "../i18n/locale.js";

/**
 * An analysis that produced no report: says so plainly, never as a result. Through the shared
 * proxy, an RPC failure may be its rate limit, so the page points to setting one's own RPC.
 */
export function ErrorPanel({
  error,
  onRetry,
  viaProxy = false,
}: {
  readonly error: ShownError;
  readonly onRetry: () => void;
  readonly viaProxy?: boolean;
}) {
  const { m } = useMessages();
  return (
    <section className="panel panel-error" role="alert">
      <h1>{m("error.title")}</h1>
      <p>{m(error.key, error.params)}</p>
      {viaProxy && error.key === "error.RPC_FAILED" ? (
        <p>
          {m("error.proxyHint")} <a href="#/settings">{m("rpc.proxy.setOwn")}</a>
        </p>
      ) : null}
      <button type="button" className="button" onClick={onRetry}>
        {m("error.retry")}
      </button>
    </section>
  );
}
