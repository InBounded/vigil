import type { AnalysisStep } from "@vigil-sol/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { describeError, type ShownError } from "./errors.js";
import { DISPLAY_STEP_OF, type DisplayStep } from "./steps.js";

export type AnalysisState<T> =
  | { readonly status: "running"; readonly step: DisplayStep | undefined }
  | { readonly status: "done"; readonly value: T }
  | { readonly status: "error"; readonly error: ShownError };

/**
 * Runs `run` whenever `key` changes or `rerun` is called, reporting progress. A result that
 * arrives after the key changed (or after a re-run started) is dropped, never shown.
 */
export function useAnalysis<T>(
  key: string,
  run: (onProgress: (step: AnalysisStep) => void) => Promise<T>,
): { readonly state: AnalysisState<T>; readonly rerun: () => void } {
  const [attempt, setAttempt] = useState(0);
  const runId = `${attempt}:${key}`;
  const [result, setResult] = useState<{
    readonly runId: string;
    readonly state: AnalysisState<T>;
  }>({ runId, state: { status: "running", step: undefined } });
  // `run` is recreated on every render: kept in a ref so only a new run id restarts it.
  const runRef = useRef(run);
  runRef.current = run;
  useEffect(() => {
    let current = true;
    const report = (state: AnalysisState<T>) => {
      if (current) {
        setResult({ runId, state });
      }
    };
    report({ status: "running", step: undefined });
    runRef
      .current((step) => report({ status: "running", step: DISPLAY_STEP_OF[step] }))
      .then(
        (value) => report({ status: "done", value }),
        (error: unknown) => report({ error: describeError(error), status: "error" }),
      );
    return () => {
      current = false;
    };
  }, [runId]);
  const rerun = useCallback(() => setAttempt((n) => n + 1), []);
  // Until the effect of a new run id has reported, the previous run's state is not shown.
  const state: AnalysisState<T> =
    result.runId === runId ? result.state : { status: "running", step: undefined };
  return { rerun, state };
}
