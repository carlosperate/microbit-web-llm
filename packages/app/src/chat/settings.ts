import { SYSTEM_PROMPT } from "./system-prompt.js";

export type AccentColor = "cyan" | "teal" | "magenta";
export type ChatVariant = "clean" | "tinted" | "bold";

export interface ChatSettings {
  temperature: number;
  /** `null` = no cap (engine default). */
  maxTokens: number | null;
  maxSteps: number;
  systemPrompt: string;
  verboseLogging: boolean;
  accentColor: AccentColor;
  chatVariant: ChatVariant;
}

export const DEFAULT_SETTINGS: ChatSettings = {
  temperature: 0.7,
  maxTokens: null,
  maxSteps: 10,
  systemPrompt: SYSTEM_PROMPT,
  verboseLogging: true,
  accentColor: "cyan",
  chatVariant: "clean",
};

export const TEMPERATURE_RANGE = { min: 0, max: 1.5, step: 0.05 };
export const MAX_TOKENS_RANGE = { min: 64, max: 8192 };
export const MAX_STEPS_RANGE = { min: 1, max: 30 };
