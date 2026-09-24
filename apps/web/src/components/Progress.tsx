import { DISPLAY_STEPS, type DisplayStep, stepLabel } from "../analysis/steps.js";
import { useMessages } from "../i18n/locale.js";

/** The analysis steps, each marked done, in progress or waiting (in words, not only visually). */
export function Progress({
  step,
  raw = false,
}: {
  readonly step: DisplayStep | undefined;
  readonly raw?: boolean;
}) {
  const { m } = useMessages();
  const current = step === undefined ? 0 : DISPLAY_STEPS.indexOf(step);
  return (
    <section className="progress" aria-busy="true" aria-labelledby="progress-title">
      <h2 id="progress-title">{m("progress.title")}</h2>
      <ol>
        {DISPLAY_STEPS.map((s, i) => {
          const state = i < current ? "done" : i === current ? "running" : "pending";
          return (
            <li
              key={s}
              className={`step step-${state}`}
              aria-current={i === current ? "step" : undefined}
            >
              <span aria-hidden="true" className="step-icon">
                {state === "done" ? "●" : state === "running" ? "◐" : "○"}
              </span>
              {m(stepLabel(s, raw))}
              <span className="visually-hidden"> ({m(`step.${state}`)})</span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
