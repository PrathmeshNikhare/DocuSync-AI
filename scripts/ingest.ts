// Usage:
//   npm run ingest -- --fixture env-var-change
//   npm run ingest -- --live owner/repo#123 --installation 12345678
// Prints the normalized PullRequestSnapshot as JSON. Read-only; never runs repo code.
import { parseArgs } from "node:util";
import { getGitHubAppEnv } from "@/lib/env";
import { createFixtureReader } from "@/lib/github/fixture-reader";
import { createOctokitReader } from "@/lib/github/octokit-reader";
import { GitHubReadError, type GitHubReader } from "@/lib/github/reader";
import { ingestPullRequest } from "@/lib/ingest";
import type { PullRequestRef } from "@/lib/schemas";
import { toTerminalSafeJson } from "@/lib/terminal-safe-json";

const LIVE_REF = /^([^/#]+)\/([^/#]+)#(\d+)$/;

function usage(): never {
  console.error(
    "Usage: --fixture <name> | --live <owner/repo#number> --installation <id>",
  );
  process.exit(2);
}

async function main() {
  const { values } = parseArgs({
    options: {
      fixture: { type: "string" },
      live: { type: "string" },
      installation: { type: "string" },
    },
  });

  let reader: GitHubReader;
  let ref: PullRequestRef;
  if (values.fixture && !values.live) {
    reader = createFixtureReader(values.fixture);
    // Fixtures always describe pull request #1.
    ref = { owner: "fixture", repo: values.fixture, number: 1 };
  } else if (values.live && !values.fixture) {
    const m = LIVE_REF.exec(values.live);
    const installationId = Number(values.installation);
    if (!m || !Number.isInteger(installationId) || installationId < 1) usage();
    const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY } = getGitHubAppEnv();
    reader = createOctokitReader({
      appId: GITHUB_APP_ID,
      privateKey: GITHUB_APP_PRIVATE_KEY,
      installationId,
    });
    ref = { owner: m[1]!, repo: m[2]!, number: Number(m[3]) };
  } else {
    usage();
  }

  const snapshot = await ingestPullRequest(reader, ref);
  // Snapshot text is untrusted (titles, patches): escape terminal-control characters.
  console.log(toTerminalSafeJson(snapshot));
}

main().catch((err: unknown) => {
  // Safe codes only: never print upstream messages, tokens or keys.
  if (err instanceof GitHubReadError) console.error(err.code);
  else if (
    err instanceof Error &&
    err.message.startsWith("Invalid server environment")
  )
    console.error(err.message);
  else console.error("INGEST_FAILED");
  process.exit(1);
});
