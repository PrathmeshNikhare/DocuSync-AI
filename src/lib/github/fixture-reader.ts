import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GitHubReadError, type GitHubReader } from "./reader";

/** Fixture names are a closed, simple alphabet so they can never escape the directory. */
export const fixtureNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

const fixtureFileSchema = z.object({
  pull: z.unknown(),
  files: z.array(z.unknown()),
});

export const DEFAULT_FIXTURE_DIR = path.join(
  process.cwd(),
  "fixtures",
  "github",
);

/**
 * Serves a synthetic pull request from `fixtures/github/<name>.json` for local
 * development and tests without GitHub credentials. The ref is ignored.
 */
export function createFixtureReader(
  name: string,
  dir: string = DEFAULT_FIXTURE_DIR,
): GitHubReader {
  const safeName = fixtureNameSchema.safeParse(name);
  if (!safeName.success) throw new GitHubReadError("FIXTURE_NOT_FOUND");

  let loaded: Promise<z.infer<typeof fixtureFileSchema>> | undefined;
  const load = () =>
    (loaded ??= readFile(path.join(dir, `${safeName.data}.json`), "utf8")
      .then((json) => fixtureFileSchema.parse(JSON.parse(json)))
      .catch(() => {
        throw new GitHubReadError("FIXTURE_NOT_FOUND");
      }));

  return {
    async getPullRequest() {
      return (await load()).pull;
    },
    async listFiles(_ref, maxFiles) {
      const { files } = await load();
      return {
        files: files.slice(0, maxFiles),
        truncated: files.length > maxFiles,
      };
    },
  };
}
