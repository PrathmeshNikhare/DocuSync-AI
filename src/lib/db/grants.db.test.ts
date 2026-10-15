import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { requireTestDbUrls, withOwner } from "@/test/db";
import { checkAppGrants } from "./grants";
import { migrate } from "./migrate";

const { ownerUrl } = requireTestDbUrls();

beforeAll(async () => {
  await withOwner(ownerUrl, (c) =>
    migrate(c, path.join(process.cwd(), "migrations")),
  );
});

/** Grants `grant`, expects `problem` to be reported, then undoes it with `undo`. */
async function expectReported(grant: string, problem: string, undo: string) {
  await withOwner(ownerUrl, async (c) => {
    await c.query(grant);
    try {
      expect(await checkAppGrants(c)).toContain(problem);
    } finally {
      await c.query(undo);
    }
    expect(await checkAppGrants(c)).toEqual([]);
  });
}

describe("checkAppGrants", () => {
  it("passes on a migrated database", async () => {
    expect(await withOwner(ownerUrl, (c) => checkAppGrants(c))).toEqual([]);
  });

  it("reports privileges a restore re-granted, and missing ones", async () => {
    await withOwner(ownerUrl, async (c) => {
      // What pg_restore plus default privileges does to one table.
      await c.query("GRANT UPDATE, DELETE ON repositories TO docusync_app");
      await c.query(
        "REVOKE INSERT ON github_output_attempts FROM docusync_app",
      );
      try {
        const problems = await checkAppGrants(c);
        expect(problems).toContain(
          "app role has UPDATE on repositories.github_repo_id",
        );
        expect(problems).toContain(
          "app role has UPDATE on repositories.source",
        );
        expect(problems).toContain(
          "app role lacks INSERT on github_output_attempts",
        );
      } finally {
        await c.query(
          "REVOKE UPDATE, DELETE ON repositories FROM docusync_app",
        );
        await c.query(
          "GRANT UPDATE (owner, name, installation_id, updated_at) ON repositories TO docusync_app",
        );
        await c.query("GRANT INSERT ON github_output_attempts TO docusync_app");
      }
      expect(await checkAppGrants(c)).toEqual([]);
    });
  });

  it("reports a single re-granted binding column (column-level)", () =>
    expectReported(
      "GRANT UPDATE (installation_id) ON github_outputs TO docusync_app",
      "app role has UPDATE on github_outputs.installation_id",
      "REVOKE UPDATE (installation_id) ON github_outputs FROM docusync_app",
    ));

  it("reports UPDATE on grants and the migration ledger", async () => {
    await expectReported(
      "GRANT UPDATE ON repository_reviewers TO docusync_app",
      "app role has UPDATE on repository_reviewers",
      "REVOKE UPDATE ON repository_reviewers FROM docusync_app",
    );
    await expectReported(
      "GRANT UPDATE ON schema_migrations TO docusync_app",
      "app role has UPDATE on schema_migrations",
      "REVOKE UPDATE ON schema_migrations FROM docusync_app",
    );
  });

  it("reports TEMPORARY on the database, which pg_dump does not carry (database-level)", () =>
    expectReported(
      "GRANT TEMPORARY ON DATABASE docusync_test TO docusync_app",
      "app role has TEMPORARY on the database",
      "REVOKE TEMPORARY ON DATABASE docusync_test FROM docusync_app",
    ));

  it("reports CREATE on schema public and TRUNCATE on any table", async () => {
    await expectReported(
      "GRANT CREATE ON SCHEMA public TO docusync_app",
      "app role has CREATE on schema public",
      "REVOKE CREATE ON SCHEMA public FROM docusync_app",
    );
    await expectReported(
      "GRANT TRUNCATE ON pull_requests TO docusync_app",
      "app role has TRUNCATE on pull_requests",
      "REVOKE TRUNCATE ON pull_requests FROM docusync_app",
    );
  });
});

describe("single-column grants on whole-table limits (security-check L-2)", () => {
  it("reports INSERT on one column of reviewers (the app could create accounts)", () =>
    expectReported(
      "GRANT INSERT (username, display_name, password_hash) ON reviewers TO docusync_app",
      "app role has INSERT on reviewers",
      "REVOKE INSERT (username, display_name, password_hash) ON reviewers FROM docusync_app",
    ));

  it("reports UPDATE on one column of an immutable table", () =>
    expectReported(
      "GRANT UPDATE (patch_text) ON patch_proposals TO docusync_app",
      "app role has UPDATE on patch_proposals",
      "REVOKE UPDATE (patch_text) ON patch_proposals FROM docusync_app",
    ));

  it("reports role attributes and memberships that let the app role widen its access", () =>
    withOwner(ownerUrl, async (c) => {
      for (const [attr, off, problem] of [
        ["CREATEDB", "NOCREATEDB", "app role can create databases"],
        ["CREATEROLE", "NOCREATEROLE", "app role can create roles"],
        ["BYPASSRLS", "NOBYPASSRLS", "app role bypasses row-level security"],
      ] as const) {
        await c.query(`ALTER ROLE docusync_app ${attr}`);
        try {
          expect(await checkAppGrants(c)).toContain(problem);
        } finally {
          await c.query(`ALTER ROLE docusync_app ${off}`);
        }
      }
      await c.query("GRANT pg_read_all_data TO docusync_app");
      try {
        expect(await checkAppGrants(c)).toContain(
          "app role is a member of other roles",
        );
      } finally {
        await c.query("REVOKE pg_read_all_data FROM docusync_app");
      }
      expect(await checkAppGrants(c)).toEqual([]);
    }));
});
