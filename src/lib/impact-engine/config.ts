export const ENGINE_VERSION = "deterministic-0.3.0";

export type SignalKind =
  | "env_var"
  | "import_export"
  | "api_route"
  | "package_script"
  | "config_key"
  | "path_change";

/**
 * Transparent ranking rules. Points are summed per doc and compared with the
 * thresholds. They order candidates; they are not probabilities and are not
 * calibrated. Change them only together with a re-run of `npm run eval:impact`.
 */
export interface EngineConfig {
  /** Points when a doc mentions a symbol, route, key or path that the PR changed. */
  weights: Record<SignalKind, number>;
  /** Multiplier when the mentioned thing was removed or renamed away. */
  removedMultiplier: number;
  /** Points for a doc that lists related env vars or scripts when a new one is undocumented. */
  undocumentedWeight: number;
  likelyThreshold: number;
  verifyThreshold: number;
  /** Shorter symbol names are ignored: they match too much prose. */
  minSymbolLength: number;
  maxEvidencePerCandidate: number;
  /** Signals beyond this are not matched (bounds work on huge PRs); a note says so. */
  maxSignals: number;
  /** Total doc characters analyzed; later docs (by path) are skipped with a note. */
  maxTotalDocChars: number;
  /** Upper bound on doc lines scanned across all signals; matching stops with a note. */
  maxLineScans: number;
}

export const DEFAULT_CONFIG: EngineConfig = {
  weights: {
    env_var: 4,
    import_export: 3,
    api_route: 4,
    package_script: 4,
    config_key: 3,
    path_change: 3,
  },
  removedMultiplier: 2,
  undocumentedWeight: 3,
  likelyThreshold: 6,
  verifyThreshold: 3,
  minSymbolLength: 3,
  maxEvidencePerCandidate: 12,
  maxSignals: 300,
  maxTotalDocChars: 10_000_000,
  maxLineScans: 20_000_000,
};
