// Usage (against a running app, e.g. `npm run build && npm start`):
//   SCREENSHOT_BASE_URL=http://localhost:3000 SCREENSHOT_USERNAME=<reviewer> \
//   SCREENSHOT_PASSWORD_FILE=<file from reviewer:add> SCREENSHOT_ANALYSIS_ID=<id> \
//   npm run screenshots
// Drives the real UI with Playwright and writes docs/screenshots/*.png. It shows
// what the app renders for the given data: use a labelled fixture analysis with
// an undecided proposal. Nothing here is mocked or edited after capture.
// It ACCEPTS that proposal as the signed-in reviewer, so it refuses anything not
// labelled as fixture data, and plain http to a non-local host (security-check
// L-6). Errors print fixed codes only: Playwright messages can quote typed text.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

/** A failure with a fixed, printable code; nothing else is ever printed. */
class Refused extends Error {}
const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Refused(`MISSING_${name}`);
  return v;
};
async function main() {
  const base = env("SCREENSHOT_BASE_URL").replace(/\/$/, "");
  const target = URL.canParse(base) ? new URL(base) : undefined;
  if (!target) throw new Refused("SCREENSHOT_BASE_URL_INVALID");
  if (
    target.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
  )
    throw new Refused("SCREENSHOT_BASE_URL_NOT_HTTPS");
  const username = env("SCREENSHOT_USERNAME");
  const password = readFileSync(env("SCREENSHOT_PASSWORD_FILE"), "utf8").trim();
  const analysisId = env("SCREENSHOT_ANALYSIS_ID");
  const out = path.join(process.cwd(), "docs", "screenshots");
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    colorScheme: "light",
  });
  // Pages stream their data behind a "Loading…" fallback: wait until it is gone.
  const settled = () =>
    page.getByText(/^Loading /).waitFor({ state: "detached" });
  // Captures stay in memory and are written only if the whole run succeeds, so
  // a refused or failed run never replaces existing screenshots.
  const captured = new Map<string, Buffer>();
  const shot = async (name: string) => {
    await settled();
    captured.set(name, await page.screenshot({ fullPage: true }));
  };
  try {
    await page.goto(`${base}/login`);
    await page.getByLabel("Username").fill(username);
    await shot("01-login");
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL(`${base}/`);
    await page.getByRole("heading", { level: 1 }).waitFor();
    await shot("02-dashboard");

    await page.goto(`${base}/analyses/${analysisId}`);
    await page
      .getByRole("link", { name: "Review proposed patch" })
      .first()
      .waitFor();
    await shot("03-analysis");

    await page
      .getByRole("link", { name: "Review proposed patch" })
      .first()
      .click();
    await page.getByRole("button", { name: "Accept…" }).waitFor();
    // Never record an approval for live data: the review page must show the
    // fixture label before anything is accepted.
    if (
      (await page.getByText("Fixture data, not a live repository").count()) ===
      0
    )
      throw new Refused("NOT_FIXTURE_DATA");
    await shot("04-review");

    await page.getByRole("button", { name: "Accept…" }).click();
    await page.getByRole("button", { name: "Confirm accept" }).waitFor();
    await shot("05-accept-confirm");

    await page.getByRole("button", { name: "Confirm accept" }).click();
    await page
      .getByRole("heading", { name: "Decision", exact: true })
      .waitFor();
    await shot("06-decided");
  } finally {
    await browser.close();
  }
  for (const [name, png] of captured) {
    writeFileSync(path.join(out, `${name}.png`), png);
    console.log(`docs/screenshots/${name}.png`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Refused ? err.message : "SCREENSHOTS_FAILED");
  process.exit(1);
});
