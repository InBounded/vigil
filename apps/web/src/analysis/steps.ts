import type { AnalysisStep } from "@vigil-sol/core";
import type { MessageKey } from "../i18n/messages.js";

/** The steps shown while an analysis runs; each groups some of core's `AnalysisStep`s. */
export type DisplayStep = "connect" | "read" | "decode" | "simulate" | "programs" | "analyse";

export const DISPLAY_STEPS: readonly DisplayStep[] = [
  "connect",
  "read",
  "decode",
  "simulate",
  "programs",
  "analyse",
];

export const DISPLAY_STEP_OF: Readonly<Record<AnalysisStep, DisplayStep>> = {
  annotate: "decode",
  balances: "analyse",
  cluster: "connect",
  "cross-check": "analyse",
  decode: "decode",
  history: "analyse",
  programs: "programs",
  proposal: "read",
  rules: "analyse",
  simulate: "simulate",
  verification: "programs",
};

export function stepLabel(step: DisplayStep, raw: boolean): MessageKey {
  switch (step) {
    case "connect":
      return "step.connect";
    case "read":
      return raw ? "step.readTransaction" : "step.read";
    case "decode":
      return "step.decode";
    case "simulate":
      return "step.simulate";
    case "programs":
      return "step.programs";
    case "analyse":
      return "step.analyse";
  }
}
