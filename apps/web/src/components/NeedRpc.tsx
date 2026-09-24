import { type FormEvent, useId, useState } from "react";
import { useEnvironment } from "../env/context.js";
import { useMessages } from "../i18n/locale.js";
import { parseRpcUrl } from "../lib/validate.js";
import { useSettings } from "../settings/context.js";

/**
 * Mainnet without an endpoint of the user's: explain why one is needed and take it here. No
 * provider is named or linked (maintainer decision, docs/DECISIONS.md).
 */
export function NeedRpc() {
  const { m } = useMessages();
  const { settings, update } = useSettings();
  const { settingsStore } = useEnvironment();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const id = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const url = parseRpcUrl(value);
    if (url === undefined) {
      setInvalid(true);
      return;
    }
    update({ ...settings, rpc: { ...settings.rpc, mainnet: url } });
  };
  return (
    <section className="panel" aria-labelledby={`${id}-title`}>
      <h1 id={`${id}-title`}>{m("needRpc.title")}</h1>
      <p>{m("needRpc.explain")}</p>
      {settingsStore.persistsRpc ? null : <p className="note">{m("offline.rpcNotStored")}</p>}
      <form onSubmit={submit} noValidate>
        <label htmlFor={`${id}-url`}>{m("needRpc.field")}</label>
        <input
          id={`${id}-url`}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-error` : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            setInvalid(false);
          }}
        />
        {invalid ? (
          <p id={`${id}-error`} className="field-error">
            {m("settings.invalidUrl")}
          </p>
        ) : null}
        <button type="submit" className="button-primary">
          {m("needRpc.save")}
        </button>
      </form>
    </section>
  );
}
