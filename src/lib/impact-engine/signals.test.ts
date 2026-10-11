import { describe, expect, it } from "vitest";
import type { ChangedFile } from "@/lib/schemas";
import {
  classifyPath,
  diffLines,
  extractSignals,
  routeFromPath,
} from "./signals";

/** Builds a ChangedFile with one hunk whose header counts are computed. */
function changed(
  path: string,
  lines: string[],
  extra: Partial<ChangedFile> = {},
  start = 1,
): ChangedFile {
  return {
    path,
    status: "modified",
    additions: lines.filter((l) => l[0] === "+").length,
    deletions: lines.filter((l) => l[0] === "-").length,
    patchState: "included",
    hunks: [
      {
        oldStart: start,
        oldLines: lines.filter((l) => l[0] !== "+").length,
        newStart: start,
        newLines: lines.filter((l) => l[0] !== "-").length,
        lines,
      },
    ],
    ...extra,
  };
}

const sig = (files: ChangedFile[]) =>
  extractSignals(files).signals.map((s) => `${s.kind}:${s.value}:${s.change}`);

describe("classifyPath", () => {
  it.each([
    ["README.md", "docs"],
    ["docs/setup/index.mdx", "docs"],
    ["docs/diagram.png", "docs"],
    [".env.example", "env"],
    ["config/.env.production", "env"],
    ["package-lock.json", "lockfile"],
    ["pnpm-lock.yaml", "lockfile"],
    ["package.json", "config"],
    ["config/default.yml", "config"],
    ["pyproject.toml", "config"],
    ["src/a.test.ts", "test"],
    ["tests/data/users.json", "test"],
    ["fixtures/github/a.json", "test"],
    ["src/__tests__/a.ts", "test"],
    ["src/lib/a.tsx", "source"],
    ["scripts/run.mjs", "source"],
    ["src/main.py", "other"],
  ])("%s -> %s", (path, cls) => expect(classifyPath(path)).toBe(cls));
});

describe("routeFromPath", () => {
  it.each([
    ["src/app/api/users/route.ts", "/api/users"],
    ["app/(admin)/api/stats/route.js", "/api/stats"],
    ["src/app/api/users/[id]/route.ts", "/api/users/[id]"],
    ["pages/api/health.ts", "/api/health"],
    ["src/pages/api/users/index.ts", "/api/users"],
    ["src/app/api/users/page.tsx", undefined],
    ["src/lib/route.ts", undefined],
  ])("%s -> %s", (path, route) => expect(routeFromPath(path)).toBe(route));
});

describe("diffLines", () => {
  it("numbers removed lines in the base and added lines in the head", () => {
    const f = changed(
      "src/a.ts",
      [" keep", "-old1", "-old2", "+new1", " tail"],
      {},
      10,
    );
    expect(diffLines(f).map((l) => `${l.prefix}${l.line}:${l.text}`)).toEqual([
      " 10:keep",
      "-11:old1",
      "-12:old2",
      "+11:new1",
      " 13:tail",
    ]);
  });

  it("skips no-newline markers without shifting line numbers", () => {
    const f = changed("src/a.ts", ["-a", "\\ No newline at end of file", "+b"]);
    expect(diffLines(f).map((l) => `${l.prefix}${l.line}`)).toEqual([
      "-1",
      "+1",
    ]);
  });
});

describe("extractSignals", () => {
  it("finds env vars in all three source forms and in .env files", () => {
    expect(
      sig([
        changed("src/a.ts", [
          "+const a = process.env.ALPHA;",
          '+const b = process.env["BETA"];',
          "+const c = import.meta.env.GAMMA;",
          "+const d = process.env[name]; // dynamic: not extracted",
        ]),
        changed(".env.example", [
          "+DELTA=1",
          "+export EPSILON=2",
          "+# COMMENT=3",
        ]),
      ]).filter((s) => s.startsWith("env_var")),
    ).toEqual([
      "env_var:ALPHA:added",
      "env_var:BETA:added",
      "env_var:DELTA:added",
      "env_var:EPSILON:added",
      "env_var:GAMMA:added",
    ]);
  });

  it("classifies removed, added and modified across the whole PR", () => {
    const s = sig([
      changed("src/a.ts", [
        "-export function sum() {}",
        "+export function add() {}",
        "-export const config = 1;",
        "+export const config = 2;",
      ]),
    ]);
    expect(s).toContain("import_export:sum:removed");
    expect(s).toContain("import_export:add:added");
    expect(s).toContain("import_export:config:modified");
  });

  it("reads export lists with aliases and ignores non-exported declarations", () => {
    const s = sig([
      changed("src/a.ts", [
        "+export { one, two as second };",
        "+function hidden() {}",
        "+const LIMIT = 1;",
      ]),
    ]).filter((x) => x.startsWith("import_export"));
    expect(s).toEqual([
      "import_export:one:added",
      "import_export:second:added",
    ]);
  });

  it("keeps the evidence line paired with the file it came from", () => {
    const { signals } = extractSignals([
      changed("src/new.ts", ["+export function moved() {}"]),
      changed("src/old.ts", [" // header", "-export function moved() {}"]),
    ]);
    const moved = signals.find((s) => s.value === "moved")!;
    expect(moved.change).toBe("modified");
    // The removed line is preferred, and it lives in src/old.ts at base line 2.
    expect(moved.evidence).toMatchObject({
      sourcePath: "src/old.ts",
      side: "base",
      lineRange: { start: 2, end: 2 },
      excerpt: "export function moved() {}",
    });
  });

  it("keeps only npm scripts from package.json, never versions or metadata", () => {
    const s = sig([
      changed("package.json", [
        '   "name": "demo",',
        '-  "version": "1.0.0",',
        '+  "version": "1.1.0",',
        '   "scripts": {',
        '-    "lint:fix": "eslint --fix .",',
        '+    "fix": "eslint --fix .",',
        '     "test": "vitest"',
        "   },",
        '+  "private": true',
      ]),
    ]).filter((x) => !x.startsWith("path_change"));
    expect(s).toEqual([
      "package_script:fix:added",
      "package_script:lint:fix:removed",
    ]);
  });

  it("resets package.json block state per hunk and classifies keys whose header is out of view", () => {
    const pkg: ChangedFile = {
      ...changed("package.json", []),
      hunks: [
        {
          oldStart: 5,
          oldLines: 4,
          newStart: 5,
          newLines: 4,
          lines: [
            '   "scripts": {',
            '-    "build:docs": "typedoc",',
            '+    "docs:build": "typedoc",',
            '     "test": "vitest run"',
          ],
        },
        {
          // Still inside devDependencies, but the header is out of view.
          oldStart: 30,
          oldLines: 2,
          newStart: 30,
          newLines: 2,
          lines: [
            '-    "typescript": "^5.8.0",',
            '+    "typescript": "^5.9.0",',
          ],
        },
        {
          // Deep inside a long scripts block: header out of view.
          oldStart: 50,
          oldLines: 1,
          newStart: 50,
          newLines: 1,
          lines: [
            '-    "start:prod": "next start",',
            '+    "start:production": "next start",',
          ],
        },
        {
          oldStart: 70,
          oldLines: 3,
          newStart: 70,
          newLines: 3,
          lines: [
            '   "dependencies": {',
            '-    "zod": "^4.6.0"',
            '+    "zod": "^4.6.5"',
          ],
        },
      ],
    };
    expect(sig([pkg]).filter((x) => !x.startsWith("path_change"))).toEqual([
      "package_script:build:docs:removed",
      "package_script:docs:build:added",
      "package_script:start:prod:removed",
      "package_script:start:production:added",
    ]);
  });

  it("handles hostile package.json lines in linear time", () => {
    const spaces = " ".repeat(64_000);
    const start = performance.now();
    extractSignals([
      changed("package.json", [
        `+"k": a${spaces}b`,
        `+}${spaces}x`,
        ` "k": a${spaces}b`,
      ]),
    ]);
    // The old JSON key/value regex needed ~70 s for 8,000 spaces.
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("points removed lines of a renamed file at the old path", () => {
    const { signals } = extractSignals([
      changed(
        "src/new.ts",
        ["-export function gone() {}", "+export function kept() {}"],
        {
          status: "renamed",
          previousPath: "src/old.ts",
        },
      ),
    ]);
    expect(signals.find((s) => s.value === "gone")!.evidence).toMatchObject({
      sourcePath: "src/old.ts",
      side: "base",
    });
    expect(signals.find((s) => s.value === "kept")!.evidence).toMatchObject({
      sourcePath: "src/new.ts",
      side: "head",
    });
  });

  it("drops overlong names and caps context hints", () => {
    const long = "A".repeat(201);
    const ctx = Array.from({ length: 300 }, (_, i) => ` CTX_${i}=1`);
    const out = extractSignals([
      changed(".env.example", [...ctx, `+${long}=1`, "+SHORT_ONE=1"]),
    ]);
    expect(out.signals.some((s) => s.value === long)).toBe(false);
    expect(out.signals.some((s) => s.value === "SHORT_ONE")).toBe(true);
    expect(out.contextEnvVars.length).toBe(200);
  });

  it("extracts YAML and TOML keys", () => {
    expect(
      sig([
        changed("config/app.yml", ["-  timeout: 30", "+  timeout: 60"]),
        changed("config/app.toml", ["+line_length = 100"]),
      ]).filter((x) => x.startsWith("config_key")),
    ).toEqual(["config_key:line_length:added", "config_key:timeout:modified"]);
  });

  it("ignores keys in CI workflows, tool configs and data files", () => {
    expect(
      sig([
        changed(".github/workflows/ci.yml", [
          "-        run: npm ci",
          "+        run: npm install",
        ]),
        changed("pyproject.toml", ["+line_length = 100"]),
        changed("src/i18n/en.json", ['+  "greeting": "Hello"']),
        changed("tsconfig.json", [
          '-    "strict": false,',
          '+    "strict": true,',
        ]),
      ]).filter((x) => !x.startsWith("path_change")),
    ).toEqual([]);
  });

  it("reports context-line env vars and scripts as hints, not signals", () => {
    const out = extractSignals([
      changed(".env.example", [" PORT=3000", "+NEW_FLAG=1"]),
      changed("package.json", [
        '   "scripts": {',
        '     "dev": "next dev",',
        '+    "fix": "x"',
      ]),
    ]);
    expect(out.contextEnvVars).toEqual(["PORT"]);
    expect(out.contextScripts).toEqual(["dev"]);
    expect(
      out.signals.some((s) => s.value === "PORT" || s.value === "dev"),
    ).toBe(false);
  });

  it("emits path and route signals for renames, and no symbols for docs, lockfiles or unparsed patches", () => {
    // docs/guide.md is edited in place: no path signal (docs linking to it stay valid).
    const s = sig([
      {
        path: "src/app/api/members/route.ts",
        previousPath: "src/app/api/users/route.ts",
        status: "renamed",
        additions: 0,
        deletions: 0,
        patchState: "omitted",
        hunks: [],
      },
      changed("docs/guide.md", ["+process.env.FROM_DOCS"]),
      changed("package-lock.json", ['+  "lockfileVersion": 3']),
      {
        ...changed("src/big.ts", []),
        patchState: "too_large",
        hunks: [],
        additions: 5,
      },
    ]);
    expect(s).toEqual([
      "api_route:/api/members:added",
      "api_route:/api/users:removed",
      "path_change:package-lock.json:modified",
      "path_change:src/app/api/members/route.ts:added",
      "path_change:src/app/api/users/route.ts:removed",
      "path_change:src/big.ts:modified",
    ]);
  });

  it("finds inline framework routes on changed lines", () => {
    expect(
      sig([
        changed("src/server.ts", [
          '+router.post("/api/login", handler);',
          ' app.get("/health", h);',
        ]),
      ]).filter((x) => x.startsWith("api_route")),
    ).toEqual(["api_route:/api/login:added"]);
  });
});
