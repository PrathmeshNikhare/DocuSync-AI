// Opt-in: `npm run test:ollama` with OLLAMA_MODEL set and Ollama running. Fails
// (never skips) without them, like the database project.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { assistImpact } from "@/lib/assist/assist";
import { getOllamaEnv, type OllamaEnv } from "@/lib/env";
import { scenarioSchema, snapshotFor } from "@/lib/impact-engine/evaluate";
import { gitBlobSha } from "@/lib/patches/blob-sha";
import { knownLinksIn } from "@/lib/patches/content";
import { validatePatch } from "@/lib/patches/validate";
import { patchProposalSchema } from "@/lib/schemas";
import { createOllamaProvider } from "./ollama";
import { ASSESS_SYSTEM, assessOutputSchema } from "./prompts";
import { generateStructured } from "./provider";

const load = (id: string) =>
  scenarioSchema.parse(
    JSON.parse(readFileSync(`fixtures/impact/${id}.json`, "utf8")),
  );

let env: OllamaEnv;
beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const e = getOllamaEnv();
  if (!e) throw new Error("Set OLLAMA_MODEL to run the Ollama tests");
  env = e;
});

describe("Ollama (live)", { timeout: 300_000 }, () => {
  it("returns schema-valid structured output", async () => {
    const r = await generateStructured(createOllamaProvider(env), {
      promptVersion: "live-test",
      system: ASSESS_SYSTEM,
      data: {
        task: "assess",
        doc: {
          path: "README.md",
          excerpts: [{ startLine: 1, text: "Set `API_TOKEN`." }],
        },
        evidence: [
          { index: 0, signal: "env_var", excerpt: "-process.env.API_TOKEN" },
        ],
      },
      schema: assessOutputSchema,
    });
    expect(r.ok).toBe(true);
  });

  it("keeps every invariant on the prompt-injection fixture", async () => {
    const s = load("injection-in-doc");
    const docs = Object.entries(s.docs).map(([path, content]) => ({
      path,
      content,
    }));
    const snapshot = snapshotFor(s);
    const r = await assistImpact(snapshot, docs, createOllamaProvider(env));
    // Whatever the model said, deterministic evidence is unchanged.
    expect(r.deterministic.candidates[0]).toMatchObject({
      docPath: "docs/configuration.md",
      status: "likely_affected",
    });
    for (const p of r.proposals) {
      const doc = s.docs[p.targetPath]!;
      expect(patchProposalSchema.parse(p)).toEqual(p);
      expect(p.targetPath).toBe("docs/configuration.md");
      expect(p.baseBlobSha).toBe(gitBlobSha(doc));
      expect(
        validatePatch({
          targetPath: p.targetPath,
          patch: p.patch,
          baseBlobSha: p.baseBlobSha,
          doc: { path: p.targetPath, content: doc },
          relatedLines: [],
          relatedTerms: ["API_KEY", "API_TOKEN"],
          knownLinks: knownLinksIn(doc),
        }).ok,
      ).toBe(true);
    }
  });

  it("reports a missing model clearly", async () => {
    const r = await createOllamaProvider({
      ...env,
      model: "docusync-no-such-model:0b",
    }).chat({
      system: "s",
      user: "{}",
      jsonSchema: { type: "object" },
      attempt: 1,
    });
    expect(r).toEqual({ ok: false, code: "LLM_MODEL_NOT_FOUND" });
  });

  it("reports an unreachable server clearly", async () => {
    const r = await createOllamaProvider({
      ...env,
      baseUrl: "http://127.0.0.1:9",
      timeoutMs: 5_000,
    }).chat({
      system: "s",
      user: "{}",
      jsonSchema: { type: "object" },
      attempt: 1,
    });
    expect(r).toEqual({ ok: false, code: "LLM_UNAVAILABLE" });
  });
});
