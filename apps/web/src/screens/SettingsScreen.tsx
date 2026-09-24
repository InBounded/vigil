import { parseUserLabels, serializeUserLabels, UserLabelsError } from "@vigil-sol/core";
import { type ChangeEvent, type FormEvent, useId, useState } from "react";
import { PUBLIC_DEVNET_RPC, sameEndpoint } from "../analysis/endpoints.js";
import { Address, ClusterContext } from "../components/Address.js";
import { useEnvironment } from "../env/context.js";
import { useMessages } from "../i18n/locale.js";
import type { MessageKey } from "../i18n/messages.js";
import { WEB_CLUSTERS, type WebCluster } from "../lib/routes.js";
import { parseAddress, parseRpcUrl } from "../lib/validate.js";
import { useSettings } from "../settings/context.js";
import {
  cleanLabel,
  isValidPercent,
  type KnownAddress,
  MAX_HISTORY_DEPTH,
  MAX_KNOWN_ADDRESSES,
  type Settings,
} from "../settings/settings.js";
import {
  parseAmountSetting,
  THRESHOLD_ASSETS,
  THRESHOLD_DECIMALS,
  type ThresholdAsset,
} from "../settings/thresholds.js";

interface FormValues {
  cluster: WebCluster;
  rpcMainnet: string;
  rpcDevnet: string;
  crossMainnet: string;
  crossDevnet: string;
  verification: boolean;
  historyDepth: string;
  percent: string;
  absolute: Record<ThresholdAsset, string>;
}

type FieldErrors = Partial<Record<keyof Omit<FormValues, "absolute"> | ThresholdAsset, MessageKey>>;

function toForm(settings: Settings): FormValues {
  return {
    absolute: { ...settings.largeTransferAbsolute },
    cluster: settings.cluster,
    crossDevnet: settings.crossCheckRpc.devnet,
    crossMainnet: settings.crossCheckRpc.mainnet,
    historyDepth: String(settings.historyDepth),
    percent: String(settings.largeTransferPercent),
    rpcDevnet: settings.rpc.devnet,
    rpcMainnet: settings.rpc.mainnet,
    verification: settings.verification,
  };
}

/** Validates the whole form; either every field is valid (new settings) or the errors. */
function fromForm(
  form: FormValues,
  base: Settings,
): { readonly settings: Settings } | { readonly errors: FieldErrors } {
  const errors: FieldErrors = {};
  const url = (field: "rpcMainnet" | "rpcDevnet" | "crossMainnet" | "crossDevnet") => {
    const text = form[field].trim();
    if (text === "") {
      return "";
    }
    const parsed = parseRpcUrl(text);
    if (parsed === undefined) {
      errors[field] = "settings.invalidUrl";
      return "";
    }
    return parsed;
  };
  const rpc = { devnet: url("rpcDevnet"), mainnet: url("rpcMainnet") };
  const cross = { devnet: url("crossDevnet"), mainnet: url("crossMainnet") };
  if (cross.mainnet !== "" && rpc.mainnet !== "" && sameEndpoint(cross.mainnet, rpc.mainnet)) {
    errors.crossMainnet = "settings.crossCheck.same";
  }
  if (
    cross.devnet !== "" &&
    sameEndpoint(cross.devnet, rpc.devnet === "" ? PUBLIC_DEVNET_RPC : rpc.devnet)
  ) {
    errors.crossDevnet = "settings.crossCheck.same";
  }
  const history = Number(form.historyDepth.trim());
  if (!/^\d+$/.test(form.historyDepth.trim()) || history > MAX_HISTORY_DEPTH) {
    errors.historyDepth = "settings.invalidNumber";
  }
  const percent = Number(form.percent.trim());
  if (form.percent.trim() === "" || !isValidPercent(percent)) {
    errors.percent = "settings.invalidNumber";
  }
  for (const asset of THRESHOLD_ASSETS) {
    if (parseAmountSetting(asset, form.absolute[asset]) === undefined) {
      errors[asset] = "settings.invalidAmount";
    }
  }
  if (Object.keys(errors).length > 0) {
    return { errors };
  }
  return {
    settings: {
      ...base,
      cluster: form.cluster,
      crossCheckRpc: cross,
      historyDepth: history,
      largeTransferAbsolute: {
        SOL: form.absolute.SOL.trim(),
        USDC: form.absolute.USDC.trim(),
        USDT: form.absolute.USDT.trim(),
      },
      largeTransferPercent: percent,
      rpc,
      verification: form.verification,
    },
  };
}

export default function SettingsScreen() {
  const { m } = useMessages();
  const { settings, update } = useSettings();
  const { settingsStore } = useEnvironment();
  const [form, setForm] = useState<FormValues>(() => toForm(settings));
  const [errors, setErrors] = useState<FieldErrors>({});
  const [status, setStatus] = useState<MessageKey | undefined>(undefined);
  const id = useId();
  const set = <K extends keyof FormValues>(field: K, value: FormValues[K]) => {
    setForm((previous) => ({ ...previous, [field]: value }));
    setStatus(undefined);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = fromForm(form, settings);
    if ("errors" in result) {
      setErrors(result.errors);
      setStatus(undefined);
      return;
    }
    setErrors({});
    setStatus(update(result.settings) ? "settings.saved" : "settings.storageUnavailable");
  };
  const error = (field: keyof FieldErrors, params: Record<string, string> = {}) => {
    const key = errors[field];
    return key === undefined ? null : (
      <p id={`${id}-${field}-error`} className="field-error">
        {m(key, params)}
      </p>
    );
  };
  const describedBy = (field: keyof FieldErrors, help?: string) =>
    [help, errors[field] === undefined ? undefined : `${id}-${field}-error`]
      .filter((part) => part !== undefined)
      .join(" ") || undefined;
  const urlField = (
    field: "rpcMainnet" | "rpcDevnet" | "crossMainnet" | "crossDevnet",
    label: MessageKey,
    help: MessageKey,
  ) => (
    <div className="field">
      <label htmlFor={`${id}-${field}`}>{m(label)}</label>
      <p id={`${id}-${field}-help`} className="help">
        {m(help)}
      </p>
      <input
        id={`${id}-${field}`}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={form[field]}
        aria-invalid={errors[field] !== undefined}
        aria-describedby={describedBy(field, `${id}-${field}-help`)}
        onChange={(event) => set(field, event.target.value)}
      />
      {error(field)}
    </div>
  );
  return (
    <section className="settings">
      <h1>{m("settings.title")}</h1>
      <form onSubmit={submit} noValidate>
        <fieldset>
          <legend>{m("settings.section.network")}</legend>
          <p className="help">{m("settings.rpc.help")}</p>
          {settingsStore.persistsRpc ? null : <p className="note">{m("offline.rpcNotStored")}</p>}
          <div className="field">
            <label htmlFor={`${id}-cluster`}>{m("settings.cluster")}</label>
            <select
              id={`${id}-cluster`}
              value={form.cluster}
              onChange={(event) => {
                const next = WEB_CLUSTERS.find((c) => c === event.target.value);
                if (next !== undefined) {
                  set("cluster", next);
                }
              }}
            >
              {WEB_CLUSTERS.map((c) => (
                <option key={c} value={c}>
                  {m(`cluster.${c}`)}
                </option>
              ))}
            </select>
          </div>
          {urlField("rpcMainnet", "settings.rpc.mainnet", "settings.rpc.mainnet.help")}
          {urlField("rpcDevnet", "settings.rpc.devnet", "settings.rpc.devnet.help")}
          {urlField("crossMainnet", "settings.crossCheck.mainnet", "settings.crossCheck.help")}
          {urlField("crossDevnet", "settings.crossCheck.devnet", "settings.crossCheck.help")}
        </fieldset>
        <fieldset>
          <legend>{m("settings.section.analysis")}</legend>
          <div className="field field-checkbox">
            <input
              id={`${id}-verification`}
              type="checkbox"
              checked={form.verification}
              aria-describedby={`${id}-verification-help`}
              onChange={(event) => set("verification", event.target.checked)}
            />
            <label htmlFor={`${id}-verification`}>{m("settings.external")}</label>
            <p id={`${id}-verification-help`} className="help">
              {m("settings.external.help")}
            </p>
          </div>
          <div className="field">
            <label htmlFor={`${id}-historyDepth`}>{m("settings.history")}</label>
            <p id={`${id}-historyDepth-help`} className="help">
              {m("settings.history.help")}
            </p>
            <input
              id={`${id}-historyDepth`}
              type="text"
              inputMode="numeric"
              value={form.historyDepth}
              aria-invalid={errors.historyDepth !== undefined}
              aria-describedby={describedBy("historyDepth", `${id}-historyDepth-help`)}
              onChange={(event) => set("historyDepth", event.target.value)}
            />
            {error("historyDepth", { max: String(MAX_HISTORY_DEPTH), min: "0" })}
          </div>
          <fieldset>
            <legend>{m("settings.thresholds")}</legend>
            <p id={`${id}-thresholds-help`} className="help">
              {m("settings.thresholds.help")}
            </p>
            <div className="field">
              <label htmlFor={`${id}-percent`}>{m("settings.thresholds.percent")}</label>
              <input
                id={`${id}-percent`}
                type="text"
                inputMode="decimal"
                value={form.percent}
                aria-invalid={errors.percent !== undefined}
                aria-describedby={describedBy("percent", `${id}-thresholds-help`)}
                onChange={(event) => set("percent", event.target.value)}
              />
              {error("percent", { max: "100", min: "0.01" })}
            </div>
            <p className="help">{m("settings.thresholds.absolute")}</p>
            {THRESHOLD_ASSETS.map((asset) => (
              <div className="field field-inline" key={asset}>
                <label htmlFor={`${id}-${asset}`}>{asset}</label>
                <input
                  id={`${id}-${asset}`}
                  type="text"
                  inputMode="decimal"
                  value={form.absolute[asset]}
                  aria-invalid={errors[asset] !== undefined}
                  aria-describedby={describedBy(asset)}
                  onChange={(event) =>
                    set("absolute", { ...form.absolute, [asset]: event.target.value })
                  }
                />
                {error(asset, { decimals: String(THRESHOLD_DECIMALS[asset]) })}
              </div>
            ))}
          </fieldset>
          <div className="field">
            <label htmlFor={`${id}-language`}>{m("settings.language")}</label>
            <select
              id={`${id}-language`}
              value="en"
              aria-describedby={`${id}-language-help`}
              disabled
            >
              <option value="en">English</option>
            </select>
            <p id={`${id}-language-help`} className="help">
              {m("settings.language.help")}
            </p>
          </div>
        </fieldset>
        <button type="submit" className="button-primary">
          {m("settings.save")}
        </button>
        <p role="status" className="form-status">
          {status === undefined ? "" : m(status)}
        </p>
      </form>
      <KnownAddresses />
      <DeleteData />
    </section>
  );
}

function KnownAddresses() {
  const { m } = useMessages();
  const { settings, update } = useSettings();
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [message, setMessage] = useState<string | undefined>(undefined);
  const id = useId();
  const known = settings.knownAddresses;
  const save = (list: readonly KnownAddress[], note?: string) => {
    const stored = update({ ...settings, knownAddresses: list.slice(0, MAX_KNOWN_ADDRESSES) });
    setMessage(stored ? note : m("settings.storageUnavailable"));
  };
  const add = (event: FormEvent) => {
    event.preventDefault();
    const parsed = parseAddress(address.trim());
    const clean = cleanLabel(label);
    if (parsed === undefined || clean === "") {
      setMessage(m("settings.known.invalid"));
      return;
    }
    save([...known.filter((entry) => entry.address !== parsed), { address: parsed, label: clean }]);
    setAddress("");
    setLabel("");
  };
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) {
      return;
    }
    try {
      const parsed = parseUserLabels(await file.text());
      const merged = new Map(known.map((entry) => [entry.address, entry.label]));
      for (const [key, value] of parsed.labels) {
        const clean = cleanLabel(value);
        if (clean !== "") {
          merged.set(key, clean);
        }
      }
      const note = [
        m("settings.known.imported", { count: String(parsed.labels.size) }),
        parsed.issues.length === 0
          ? ""
          : m("settings.known.importIssues", { count: String(parsed.issues.length) }),
      ]
        .filter((part) => part !== "")
        .join(" ");
      save(
        [...merged].map(([key, value]) => ({ address: key, label: value })),
        note,
      );
    } catch (error) {
      setMessage(error instanceof UserLabelsError ? error.message : m("settings.known.invalid"));
    }
  };
  const exportFile = () => {
    const json = serializeUserLabels(new Map(known.map((entry) => [entry.address, entry.label])));
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "vigil-labels.json";
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <section className="section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{m("settings.known")}</h2>
      <p className="help">{m("settings.known.help")}</p>
      {known.length === 0 ? (
        <p>{m("settings.known.empty")}</p>
      ) : (
        <ClusterContext value="unknown">
          <ul className="known">
            {known.map((entry) => (
              <li key={entry.address}>
                <Address address={entry.address} label={entry.label} />
                <button
                  type="button"
                  className="button-small"
                  onClick={() => save(known.filter((other) => other.address !== entry.address))}
                >
                  {m("settings.known.remove", { label: entry.label })}
                </button>
              </li>
            ))}
          </ul>
        </ClusterContext>
      )}
      <form onSubmit={add} noValidate className="known-add">
        <div className="field">
          <label htmlFor={`${id}-address`}>{m("settings.known.address")}</label>
          <input
            id={`${id}-address`}
            type="text"
            spellCheck={false}
            autoComplete="off"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor={`${id}-label`}>{m("settings.known.label")}</label>
          <input
            id={`${id}-label`}
            type="text"
            autoComplete="off"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <button type="submit" className="button">
          {m("settings.known.add")}
        </button>
      </form>
      <div className="actions">
        <label className="button file-button" htmlFor={`${id}-import`}>
          {m("settings.known.import")}
        </label>
        <input
          id={`${id}-import`}
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          onChange={(event) => {
            importFile(event);
          }}
        />
        <button type="button" className="button" onClick={exportFile} disabled={known.length === 0}>
          {m("settings.known.export")}
        </button>
      </div>
      <p role="status" className="form-status">
        {message ?? ""}
      </p>
    </section>
  );
}

function DeleteData() {
  const { m } = useMessages();
  const { reset } = useSettings();
  const { deleteLocalData } = useEnvironment();
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<MessageKey | undefined>(undefined);
  const id = useId();
  return (
    <section className="section" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{m("settings.section.data")}</h2>
      <p className="help">{m("settings.delete.help")}</p>
      {confirming ? (
        <div className="actions">
          <button
            type="button"
            className="button-danger"
            onClick={() => {
              deleteLocalData().then(
                (complete) => {
                  reset();
                  setConfirming(false);
                  setMessage(complete ? "settings.delete.done" : "settings.delete.partial");
                },
                () => {
                  setConfirming(false);
                  setMessage("settings.delete.partial");
                },
              );
            }}
          >
            {m("settings.delete.confirm")}
          </button>
          <button type="button" className="button" onClick={() => setConfirming(false)}>
            {m("settings.delete.cancel")}
          </button>
        </div>
      ) : (
        <button type="button" className="button-danger" onClick={() => setConfirming(true)}>
          {m("settings.delete")}
        </button>
      )}
      <p role="status" className="form-status">
        {message === undefined ? "" : m(message)}
      </p>
    </section>
  );
}
