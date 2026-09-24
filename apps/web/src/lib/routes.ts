import type { Address } from "@solana/kit";
import { parseAddress, parseBase64Transaction, parseIndex } from "./validate.js";

/** Networks the web app can analyse on. */
export type WebCluster = "mainnet" | "devnet";
export const WEB_CLUSTERS: readonly WebCluster[] = ["mainnet", "devnet"];

/**
 * Hash routes, so every analysis is a shareable link that needs no server:
 *   #/                                 start page
 *   #/ms/<multisig>[?cluster=devnet]   a multisig and its recent proposals
 *   #/ms/<multisig>/<index>[?cluster=…]  the report of one proposal
 *   #/tx?data=<base64>[&cluster=…]     the report of a raw transaction
 *   #/settings, #/about
 * `cluster` defaults to mainnet.
 */
export type Route =
  | { readonly name: "home" }
  | { readonly name: "multisig"; readonly cluster: WebCluster; readonly multisig: Address }
  | {
      readonly name: "proposal";
      readonly cluster: WebCluster;
      readonly multisig: Address;
      readonly index: bigint;
    }
  | { readonly name: "transaction"; readonly cluster: WebCluster; readonly base64: string }
  | { readonly name: "settings" }
  | { readonly name: "about" }
  | { readonly name: "not-found" };

export function parseRoute(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const [path = "", query = ""] = raw.split("?", 2);
  const params = new URLSearchParams(query);
  const clusterParam = params.get("cluster") ?? "mainnet";
  const cluster = WEB_CLUSTERS.find((c) => c === clusterParam);
  const segments = path.split("/").filter((segment) => segment !== "");
  const [first, second, third, ...rest] = segments;
  if (first === undefined) {
    return { name: "home" };
  }
  if (rest.length > 0 || cluster === undefined) {
    return { name: "not-found" };
  }
  if (first === "settings" && second === undefined) {
    return { name: "settings" };
  }
  if (first === "about" && second === undefined) {
    return { name: "about" };
  }
  if (first === "ms" && second !== undefined) {
    const multisig = parseAddress(second);
    if (multisig === undefined) {
      return { name: "not-found" };
    }
    if (third === undefined) {
      return { cluster, multisig, name: "multisig" };
    }
    const index = parseIndex(third);
    return index === undefined
      ? { name: "not-found" }
      : { cluster, index, multisig, name: "proposal" };
  }
  if (first === "tx" && second === undefined) {
    const check = parseBase64Transaction(params.get("data") ?? "");
    return check.ok
      ? { base64: check.base64, cluster, name: "transaction" }
      : { name: "not-found" };
  }
  return { name: "not-found" };
}

export function formatRoute(route: Route): string {
  const suffix = (cluster: WebCluster, extra: Record<string, string> = {}) => {
    const params = new URLSearchParams(extra);
    if (cluster !== "mainnet") {
      params.set("cluster", cluster);
    }
    const query = params.toString();
    return query === "" ? "" : `?${query}`;
  };
  switch (route.name) {
    case "home":
    case "not-found":
      return "#/";
    case "settings":
      return "#/settings";
    case "about":
      return "#/about";
    case "multisig":
      return `#/ms/${route.multisig}${suffix(route.cluster)}`;
    case "proposal":
      return `#/ms/${route.multisig}/${route.index}${suffix(route.cluster)}`;
    case "transaction":
      return `#/tx${suffix(route.cluster, { data: route.base64 })}`;
  }
}
