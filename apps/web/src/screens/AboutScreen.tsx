import { useMessages } from "../i18n/locale.js";
import type { MessageKey } from "../i18n/messages.js";

const RELEASES = "https://github.com/InBounded/vigil/releases";

function List({ keys }: { readonly keys: readonly MessageKey[] }) {
  const { m } = useMessages();
  return (
    <ul>
      {keys.map((key) => (
        <li key={key}>{m(key)}</li>
      ))}
    </ul>
  );
}

/** What Vigil does and does not do, the threat model in short, and how to check the build. */
export default function AboutScreen() {
  const { m } = useMessages();
  return (
    <article className="about">
      <h1>{m("about.title")}</h1>
      <p className="lead">{m("about.intro")}</p>
      <h2>{m("about.does.title")}</h2>
      <List keys={["about.does.1", "about.does.2", "about.does.3"]} />
      <h2>{m("about.doesNot.title")}</h2>
      <List keys={["about.doesNot.1", "about.doesNot.2", "about.doesNot.3", "about.doesNot.4"]} />
      <h2>{m("about.threat.title")}</h2>
      <List
        keys={[
          "about.threat.1",
          "about.threat.2",
          "about.threat.3",
          "about.threat.4",
          "about.threat.5",
        ]}
      />
      <h2>{m("about.storage.title")}</h2>
      <p>{m("about.storage")}</p>
      <h2>{m("about.verify.title")}</h2>
      <List keys={["about.verify.1", "about.verify.2", "about.verify.3"]} />
      <p>
        <a href={RELEASES} target="_blank" rel="noopener noreferrer">
          {m("about.verify.releases")}
        </a>
      </p>
      <h2>{m("about.build")}</h2>
      <ul>
        <li>{m("about.build.version", { version: __VIGIL_VERSION__ })}</li>
        <li>
          {m("about.build.commit", { commit: "" })}
          <code className="hash">{__VIGIL_COMMIT__}</code>
        </li>
        <li>{m(`about.build.kind.${__VIGIL_BUILD__}`)}</li>
      </ul>
    </article>
  );
}
