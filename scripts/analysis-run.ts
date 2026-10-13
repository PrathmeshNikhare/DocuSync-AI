// Usage: npm run analysis:run -- --fixture env-var-renamed
//        npm run analysis:run -- --live owner/repo#123 --installation 987654
// Runs the real pipeline (deterministic engine, then the model if OLLAMA_MODEL is
// set) and saves the result as a completed analysis. Uses the app role (DATABASE_URL).
// --fixture: one labelled fixture, under a repository marked as fixture data (D-012).
//   Grant reviewers access with `npm run reviewer:grant -- --repo fixture/<name>`.
// --live: a real PR through the GitHub App (docs/13). The installation must be in
//   GITHUB_ALLOWED_INSTALLATION_IDS; the token reads pull requests and contents of
//   that one repository only. Docs are read at the PR's head commit. Same-repository
//   PRs only; nothing is checked out or executed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import { assistImpact } from "@/lib/assist/assist";
import {
  getAllowedInstallationIds,
  getGitHubAppEnv,
  getOllamaEnv,
  getServerEnv,
} from "@/lib/env";
import { fetchDocsAtHead } from "@/lib/github/docs";
import { createOctokitReader } from "@/lib/github/octokit-reader";
import { livePullSchema } from "@/lib/github/reader";
import { scenarioSchema, snapshotFor } from "@/lib/impact-engine/evaluate";
import { createOllamaProvider } from "@/lib/llm/ollama";
import { ingestPullRequest } from "@/lib/ingest";
import { saveAnalysis, saveFixtureAnalysis } from "@/lib/review/store";

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    live: { type: "string" },
    installation: { type: "string" },
  },
});
const name = values.fixture ?? "";
const live =
  /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})#(\d{1,9})$/.exec(
    values.live ?? "",
  );
const installation = /^\d{1,15}$/.test(values.installation ?? "")
  ? Number(values.installation)
  : undefined;
if (
  values.live
    ? !live || installation === undefined || values.fixture
    : !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)
) {
  console.error(
    "Usage: npm run analysis:run -- --fixture <scenario name>\n" +
      "       npm run analysis:run -- --live <owner>/<repo>#<number> --installation <id>",
  );
  process.exit(2);
}

function fail(code: string): never {
  console.error(code);
  process.exit(1);
}

const openPool = () =>
  new Pool({ connectionString: getServerEnv().DATABASE_URL, max: 1 });

async function runLive(
  owner: string,
  repo: string,
  number: number,
  id: number,
) {
  if (!getAllowedInstallationIds().has(id)) fail("INSTALLATION_NOT_ALLOWED");
  const app = getGitHubAppEnv();
  const reader = createOctokitReader({
    appId: app.GITHUB_APP_ID,
    privateKey: app.GITHUB_APP_PRIVATE_KEY,
    installationId: id,
    repositoryName: repo,
  });
  const ref = { owner, repo, number };
  const snapshot = await ingestPullRequest(reader, ref);
  const pull = livePullSchema.safeParse(await reader.getPullRequest(ref));
  if (!pull.success) fail("GITHUB_INVALID_RESPONSE");
  if (pull.data.head.sha !== snapshot.headSha) fail("GITHUB_STALE_HEAD");
  // The repository id comes from GitHub, never from the command line.
  if (!pull.data.head.repo || pull.data.head.repo.id !== pull.data.base.repo.id)
    fail("FORK_NOT_SUPPORTED");
  // The token is scoped to one repository of the installation by name; the PR
  // must be in exactly that repository (a mistyped owner could name a public
  // repository outside the installation).
  const scoped = await reader.tokenRepositoryIds();
  if (scoped.length !== 1 || scoped[0] !== pull.data.base.repo.id)
    fail("REPOSITORY_MISMATCH");
  const canonical = pull.data.base.repo;
  if (!canonical.name || !canonical.owner) fail("GITHUB_INVALID_RESPONSE");
  const { docs, notes, partial } = await fetchDocsAtHead(
    reader,
    ref,
    snapshot.headSha,
  );
  const env = getOllamaEnv();
  const result = await assistImpact(
    snapshot,
    docs,
    env && createOllamaProvider(env),
  );
  const pool = openPool();
  try {
    const analysisId = await saveAnalysis(
      pool,
      {
        kind: "github",
        githubRepoId: pull.data.base.repo.id,
        owner: canonical.owner.login,
        name: canonical.name,
        installationId: id,
        headRef: pull.data.head.ref,
        baseRef: pull.data.base.ref,
        notes,
        docsPartial: partial,
      },
      snapshot,
      docs,
      result,
    );
    console.error(
      `Saved analysis ${analysisId} (${owner}/${repo}#${number}, ${docs.length} doc(s), ` +
        `model ${result.modelStatus}, ${result.proposals.length} validated proposal(s)). ` +
        `Open /analyses/${analysisId}`,
    );
  } finally {
    await pool.end();
  }
}

async function main() {
  if (live) return runLive(live[1]!, live[2]!, Number(live[3]), installation!);
  let raw: string;
  try {
    raw = readFileSync(
      path.join(process.cwd(), "fixtures", "impact", `${name}.json`),
      "utf8",
    );
  } catch {
    console.error("FIXTURE_NOT_FOUND");
    process.exit(1);
  }
  const scenario = scenarioSchema.parse(JSON.parse(raw));
  const snapshot = snapshotFor(scenario);
  const docs = Object.entries(scenario.docs).map(([p, content]) => ({
    path: p,
    content,
  }));
  const env = getOllamaEnv();
  const result = await assistImpact(
    snapshot,
    docs,
    env && createOllamaProvider(env),
  );
  const pool = openPool();
  try {
    const id = await saveFixtureAnalysis(
      pool,
      scenario.id,
      snapshot,
      docs,
      result,
    );
    console.error(
      `Saved analysis ${id} (fixture/${scenario.id}, model ${result.modelStatus}, ` +
        `${result.proposals.length} validated proposal(s)). Open /analyses/${id}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  const code = (err as { code?: unknown })?.code;
  if (
    err instanceof Error &&
    err.message.startsWith("Invalid server environment")
  ) {
    console.error(err.message);
  } else {
    console.error(
      typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)
        ? `ANALYSIS_RUN_FAILED (${code})`
        : "ANALYSIS_RUN_FAILED",
    );
  }
  process.exit(1);
});
