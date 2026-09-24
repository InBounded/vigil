import { rpcHostOf } from "@vigil-sol/core";
import type { ChosenRpc } from "../analysis/endpoints.js";
import { PROXY_MAX_HISTORY_DEPTH } from "../analysis/options.js";
import { useMessages } from "../i18n/locale.js";

/**
 * Which RPC endpoint this page reads from (the user's own, the shared Vigil proxy or the public
 * devnet endpoint), by host name only: the URL may hold an API key.
 */
export function RpcInUse({
  rpc,
  historyDepth,
}: {
  readonly rpc: ChosenRpc;
  /** The history depth setting, to say when the proxy caps it. */
  readonly historyDepth?: number;
}) {
  const { m } = useMessages();
  const host = rpcHostOf(rpc.url);
  const capped =
    rpc.source === "proxy" && historyDepth !== undefined && historyDepth > PROXY_MAX_HISTORY_DEPTH;
  return (
    <p className="note rpc-in-use">
      {m(`rpc.inUse.${rpc.source}`, { host })}
      {rpc.source === "proxy" ? (
        <>
          {" "}
          {m("rpc.proxy.limits")} <a href="#/settings">{m("rpc.proxy.setOwn")}</a>
        </>
      ) : null}
      {capped ? (
        <>
          {" "}
          {m("rpc.proxy.historyCapped", {
            depth: String(historyDepth),
            max: String(PROXY_MAX_HISTORY_DEPTH),
          })}
        </>
      ) : null}
    </p>
  );
}
