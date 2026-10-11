import { z } from "zod";
import {
  DIFF_LIMITS,
  DOC_LIMITS,
  docFileSchema,
  impactCandidateSchema,
  type DocFile,
  type EvidenceReference,
  type ImpactCandidate,
  type PullRequestSnapshot,
} from "@/lib/schemas";
import {
  DEFAULT_CONFIG,
  ENGINE_VERSION,
  type EngineConfig,
  type SignalKind,
} from "./config";
import {
  clip,
  indexDocLinks,
  pathMatcher,
  routeMatcher,
  scanLines,
  symbolMatcher,
  type LineTest,
  type Mention,
} from "./match";
import { classifyPath, extractSignals, type Signal } from "./signals";

export interface ImpactResult {
  engineVersion: string;
  /** Docs with at least one matched rule, ordered by rank points, then path. */
  candidates: ImpactCandidate[];
  /** Docs the PR already edits; reported, not flagged. */
  docsChangedInPr: string[];
  /** PR-level gaps: unanalyzed patches, truncated or rejected files, budgets hit. */
  missingContext: string[];
}

const docsInputSchema = z
  .array(docFileSchema)
  .max(DOC_LIMITS.maxDocs)
  // Two docs with one path would merge their hits and make line evidence ambiguous.
  .refine((docs) => new Set(docs.map((d) => d.path)).size === docs.length, {
    message: "Duplicate doc paths",
  });

const KIND_LABEL: Record<SignalKind, string> = {
  env_var: "env var",
  import_export: "exported symbol",
  api_route: "API route",
  package_script: "npm script",
  config_key: "config key",
  path_change: "file path",
};

// Values and paths come from untrusted PR content. In text the engine writes
// (reason, notes) they are bounded and reduced to a plain character set, so they
// cannot break a code span or carry bidi/zero-width tricks. Quoted evidence
// excerpts are left byte-exact.
const plain = (s: string, max: number) =>
  clip(s.replace(/[^\p{L}\p{N}_$:.\-/@[\]{}()+ ]/gu, "?"), max);
const v = (s: string) => plain(s, 120);
const p = (s: string) => plain(s, 200);
const note = (s: string) => clip(s, 500);

interface Hit {
  rule: string;
  points: number;
  description: string;
  evidence: EvidenceReference[];
  /** Source file the hit depends on (for the missing-patch cap). */
  sourcePath: string;
}

/** A doc split and tokenized once, so each signal costs a set lookup before any scan. */
interface IndexedDoc {
  doc: DocFile;
  lines: string[];
  words: Set<string>;
  scriptWords: Set<string>;
  /** Resolved Markdown link targets, built on first use by a path signal. */
  links?: Map<string, Map<number, number>>;
}

const WORD = /[\w$]+/g;
const SCRIPT_WORD = /[\w$:-]+/g;

function indexDoc(doc: DocFile): IndexedDoc {
  return {
    doc,
    lines: doc.content.split("\n"),
    words: new Set(doc.content.match(WORD)),
    scriptWords: new Set(doc.content.match(SCRIPT_WORD)),
  };
}

/** Counts doc lines scanned; once spent, every further scan returns nothing. */
class WorkBudget {
  used = 0;
  exhausted = false;
  constructor(private readonly max: number) {}
  scan(d: IndexedDoc, test: LineTest): Mention[] {
    if (this.used + d.lines.length > this.max) {
      this.exhausted = true;
      return [];
    }
    this.used += d.lines.length;
    return scanLines(d.lines, test);
  }
}

/** Compiled once per signal; returns the doc lines that mention it. */
type Finder = (d: IndexedDoc) => Mention[];

function symbolFinder(
  value: string,
  kind: SignalKind,
  budget: WorkBudget,
): Finder {
  const isScript = kind === "package_script";
  const test = symbolMatcher(value, isScript ? ":-" : "");
  // Exact-token pre-check when the value is a single token of that alphabet;
  // otherwise a substring pre-check. Only docs that pass are scanned.
  const tokenOnly = (isScript ? /^[\w$:-]+$/ : /^[\w$]+$/).test(value);
  return (d) => {
    if (tokenOnly && !(isScript ? d.scriptWords : d.words).has(value))
      return [];
    if (!tokenOnly && !d.doc.content.includes(value)) return [];
    return budget.scan(d, test);
  };
}

function finderFor(s: Signal, budget: WorkBudget): Finder | undefined {
  if (s.kind === "path_change") {
    const forLinks = pathMatcher(s.value);
    const base = s.value.split("/").at(-1) ?? s.value;
    return (d) => {
      if (!d.doc.content.includes(base)) return [];
      d.links ??= indexDocLinks(d.doc.path, d.lines);
      return budget.scan(d, forLinks(d.links));
    };
  }
  if (s.kind === "api_route") {
    const test = routeMatcher(s.value);
    if (!test) return undefined;
    const statics = s.value
      .split("/")
      .filter((seg) => seg && !/^[[{:]/.test(seg));
    return (d) =>
      statics.every((seg) => d.doc.content.includes(seg))
        ? budget.scan(d, test)
        : [];
  }
  return symbolFinder(s.value, s.kind, budget);
}

const docEvidence = (
  doc: DocFile,
  kind: EvidenceReference["signal"],
  mentions: Mention[],
): EvidenceReference[] =>
  mentions.slice(0, 2).map((m) => ({
    signal: kind,
    sourcePath: doc.path,
    lineRange: { start: m.line, end: m.line },
    side: "head" as const,
    excerpt: m.excerpt,
  }));

// Renames, deletions and removed names are what make docs stale: match them first
// so the signal cap and the work budget never drop them in favour of additions.
const priority = (s: Signal) =>
  s.kind === "path_change" && s.change !== "modified"
    ? 0
    : s.change === "removed"
      ? 1
      : s.kind === "path_change"
        ? 2
        : 3;

/**
 * Deterministic impact analysis: which docs mention something this PR changed.
 * Pure function of its inputs; never calls a model, GitHub or the database.
 */
export function analyzeImpact(
  snapshot: PullRequestSnapshot,
  docsInput: readonly DocFile[],
  config: EngineConfig = DEFAULT_CONFIG,
): ImpactResult {
  const sorted = [...docsInputSchema.parse(docsInput)].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const missingContext: string[] = [];

  // Aggregate size budget: docs past it (in path order) are not analyzed.
  let totalChars = 0;
  const withinBudget = sorted.filter((d) => {
    totalChars += d.content.length;
    return totalChars <= config.maxTotalDocChars;
  });
  if (withinBudget.length < sorted.length) {
    missingContext.push(
      `${sorted.length - withinBudget.length} doc(s) were not analyzed because the documentation exceeds the size budget.`,
    );
  }
  const docs = withinBudget.map(indexDoc);

  const changedPaths = new Set(snapshot.files.map((f) => f.path));
  const docsChangedInPr = docs
    .filter((d) => changedPaths.has(d.doc.path))
    .map((d) => d.doc.path);
  const reviewable = docs.filter((d) => !changedPaths.has(d.doc.path));

  // Files whose content changed but whose patch could not be analyzed.
  const unanalyzed = new Set(
    snapshot.files
      .filter(
        (f) =>
          f.patchState !== "included" &&
          f.additions + f.deletions > 0 &&
          classifyPath(f.path) !== "docs",
      )
      .map((f) => f.path),
  );
  missingContext.unshift(
    ...[...unanalyzed].map((path) =>
      note(
        `The patch for ${p(path)} was not available, so its content changes were not analyzed.`,
      ),
    ),
  );
  if (snapshot.filesTruncated) {
    missingContext.push(
      `The PR changes more files than the analysis limit; only the first ${DIFF_LIMITS.maxFiles} were analyzed, so affected docs may be missing.`,
    );
  }
  if (snapshot.rejectedFiles.length > 0) {
    missingContext.push(
      `${snapshot.rejectedFiles.length} changed file(s) were rejected (unsafe or invalid entries) and not analyzed.`,
    );
  }

  const { signals, contextEnvVars, contextScripts } = extractSignals(
    snapshot.files,
  );
  const eligible = signals
    .filter(
      (s) =>
        s.kind === "path_change" ||
        s.kind === "api_route" ||
        s.value.length >= config.minSymbolLength,
    )
    .map((s, i) => ({ s, i }))
    .sort((a, b) => priority(a.s) - priority(b.s) || a.i - b.i)
    .map(({ s }) => s);
  if (eligible.length > config.maxSignals) {
    missingContext.push(
      `${eligible.length} signals were extracted; only the first ${config.maxSignals} were matched against docs.`,
    );
  }
  const usable = eligible.slice(0, config.maxSignals);
  const budget = new WorkBudget(config.maxLineScans);

  const hits = new Map<string, Hit[]>(reviewable.map((d) => [d.doc.path, []]));
  const mentionedAnywhere = new Set<Signal>();

  for (const s of usable) {
    const find = finderFor(s, budget);
    if (!find) continue;
    for (const d of docs) {
      const mentions = find(d);
      if (mentions.length === 0) continue;
      // Docs the PR edits count as "mentioned" (e.g. the PR documents its own new
      // env var) but are never flagged themselves.
      mentionedAnywhere.add(s);
      if (!hits.has(d.doc.path)) continue;
      const removed = s.change === "removed";
      hits.get(d.doc.path)!.push({
        rule: `${s.kind}_${s.change}`,
        points:
          config.weights[s.kind] * (removed ? config.removedMultiplier : 1),
        description: `Mentions \`${v(s.value)}\` (${KIND_LABEL[s.kind]} ${s.change} in ${p(s.path)})`,
        evidence: [
          s.evidence,
          ...docEvidence(
            d.doc,
            s.kind === "path_change" ? "doc_link" : "explicit_reference",
            mentions,
          ),
        ],
        sourcePath: s.path,
      });
    }
  }

  // A new env var or script that no doc mentions: point at docs that already list
  // related ones, or fall back to README.md, and say what is missing. Related docs
  // depend only on the kind (the new name itself is mentioned nowhere), so they are
  // computed once per kind.
  const relatedTargets = new Map<
    SignalKind,
    { doc: DocFile; mentions: Mention[] }[]
  >();
  const targetsFor = (kind: SignalKind) => {
    const cached = relatedTargets.get(kind);
    if (cached) return cached;
    const names = new Set(
      kind === "env_var"
        ? [
            ...contextEnvVars,
            ...usable.filter((o) => o.kind === kind).map((o) => o.value),
          ]
        : [
            ...contextScripts,
            ...usable.filter((o) => o.kind === kind).map((o) => o.value),
          ],
    );
    const finders = [...names].map((n) => symbolFinder(n, kind, budget));
    const targets: { doc: DocFile; mentions: Mention[] }[] = [];
    for (const d of reviewable) {
      const mentions = finders.flatMap((find) => find(d));
      if (mentions.length > 0) targets.push({ doc: d.doc, mentions });
    }
    relatedTargets.set(kind, targets);
    return targets;
  };
  const undocumentedNotes = new Map<string, string[]>();
  for (const s of usable) {
    if (s.change !== "added" || mentionedAnywhere.has(s)) continue;
    if (s.kind !== "env_var" && s.kind !== "package_script") continue;
    const missing = note(
      `\`${v(s.value)}\` (${KIND_LABEL[s.kind]} added in ${p(s.path)}) is not mentioned in any documentation file.`,
    );
    const related = targetsFor(s.kind);
    const readme = reviewable.find((d) => d.doc.path === "README.md");
    const targets =
      related.length > 0
        ? related.map((t) => ({ ...t, fallback: false }))
        : readme
          ? [{ doc: readme.doc, mentions: [], fallback: true }]
          : [];
    for (const { doc, mentions, fallback } of targets) {
      hits.get(doc.path)!.push(
        fallback
          ? {
              rule: `undocumented_${s.kind}_readme_fallback`,
              points: config.undocumentedWeight,
              description: `\`${v(s.value)}\` (${KIND_LABEL[s.kind]} added in ${p(s.path)}) is not mentioned in any doc; README.md is the default place to document it`,
              evidence: [s.evidence],
              sourcePath: s.path,
            }
          : {
              rule: `undocumented_${s.kind}`,
              points: config.undocumentedWeight,
              description: `Lists ${KIND_LABEL[s.kind]}s related to \`${v(s.value)}\` (added in ${p(s.path)}), which no doc mentions`,
              evidence: [
                s.evidence,
                ...docEvidence(doc, "repo_convention", mentions),
              ],
              sourcePath: s.path,
            },
      );
      undocumentedNotes.set(doc.path, [
        ...(undocumentedNotes.get(doc.path) ?? []),
        missing,
      ]);
    }
  }
  if (budget.exhausted) {
    missingContext.push(
      `The matching work budget (${config.maxLineScans} doc lines) was used up; some signals were not checked against every doc.`,
    );
  }

  const candidates: ImpactCandidate[] = [];
  for (const { doc } of reviewable) {
    // Strongest hits first, so the evidence and reason caps never drop the hit
    // that decided the status.
    const docHits = [...hits.get(doc.path)!].sort(
      (a, b) =>
        b.points - a.points ||
        (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) ||
        (a.description < b.description ? -1 : 1),
    );
    if (docHits.length === 0) continue;
    const rankPoints = docHits.reduce((sum, h) => sum + h.points, 0);
    let status: ImpactCandidate["status"] =
      rankPoints >= config.likelyThreshold
        ? "likely_affected"
        : rankPoints >= config.verifyThreshold
          ? "verify"
          : "unlikely_affected";
    let rules = [...new Set(docHits.map((h) => h.rule))];
    const docMissing = [...(undocumentedNotes.get(doc.path) ?? [])];
    const evidence = docHits
      .flatMap((h) => h.evidence)
      .slice(0, config.maxEvidencePerCandidate);
    // Asserting that a doc is affected needs a line in that doc as evidence.
    if (
      status === "likely_affected" &&
      !evidence.some((e) => e.sourcePath === doc.path)
    ) {
      status = "verify";
      rules = ["no_doc_evidence_cap", ...rules];
    }
    const blindHits = docHits.filter((h) => unanalyzed.has(h.sourcePath));
    if (blindHits.length > 0) {
      const blindPoints = blindHits.reduce((sum, h) => sum + h.points, 0);
      // Without a patch we only know the file changed, not how. Assert
      // likely_affected only if the analyzed evidence alone reaches it.
      if (
        status === "likely_affected" &&
        rankPoints - blindPoints < config.likelyThreshold
      ) {
        status = "verify";
        rules = ["patch_unavailable_cap", ...rules];
      }
      docMissing.push(
        ...[...new Set(blindHits.map((h) => h.sourcePath))].map((path) =>
          note(
            `The patch for ${p(path)} was not available; check the change by hand.`,
          ),
        ),
      );
    }
    const shown = docHits.slice(0, 3).map((h) => h.description);
    const more = docHits.length > 3 ? `; and ${docHits.length - 3} more` : "";
    candidates.push(
      impactCandidateSchema.parse({
        docPath: doc.path,
        status,
        reason: clip(`${shown.join("; ")}${more}.`, 500),
        evidence,
        missingContext: [...new Set(docMissing)].slice(0, 20),
        engineVersion: ENGINE_VERSION,
        rankPoints: Math.min(rankPoints, 10_000),
        rules: rules.slice(0, 20),
      }),
    );
  }

  candidates.sort(
    (a, b) => b.rankPoints - a.rankPoints || (a.docPath < b.docPath ? -1 : 1),
  );
  return {
    engineVersion: ENGINE_VERSION,
    candidates,
    docsChangedInPr,
    missingContext: missingContext.map(note),
  };
}
