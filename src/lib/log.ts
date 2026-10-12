/**
 * Structured logging with a closed set of fields. There is deliberately no way
 * to log a payload, header, token, URL or free-form error message.
 */
export interface LogFields {
  requestId?: string;
  deliveryId?: string;
  event?: string;
  action?: string;
  outcome?: string;
  code?: string;
  analysisId?: string;
  /** Opaque ids for GitHub write attempts (docs/13). */
  outputId?: string;
  reviewerId?: string;
  step?: string;
  /** Model id and prompt version of an LLM call; never the prompt itself. */
  model?: string;
  promptVersion?: string;
  durationMs?: string;
}

const ALLOWED: readonly (keyof LogFields)[] = [
  "requestId",
  "deliveryId",
  "event",
  "action",
  "outcome",
  "code",
  "analysisId",
  "outputId",
  "reviewerId",
  "step",
  "model",
  "promptVersion",
  "durationMs",
];

export function logEvent(name: string, fields: LogFields): void {
  // Copy allowed keys only: TypeScript's check doesn't stop extra properties at runtime.
  const safe: LogFields = {};
  for (const key of ALLOWED) {
    if (typeof fields[key] === "string") safe[key] = fields[key];
  }
  console.log(JSON.stringify({ ts: new Date().toISOString(), name, ...safe }));
}
