import { segmentText } from "@/lib/review/visible-text";

/**
 * Untrusted text as plain text. Invisible characters (bidi overrides, zero-width,
 * tag characters, odd spaces) become visible, labelled markers instead of acting
 * on the surrounding text. Never renders HTML or Markdown.
 */
export function VisibleText({ text }: { text: string }) {
  return (
    <>
      {segmentText(text).map((s, i) =>
        s.kind === "text" ? (
          s.text
        ) : (
          <abbr
            key={i}
            title={`${s.code} ${s.name}`}
            aria-label={`hidden character ${s.code}`}
            className="mx-px rounded bg-amber-200 px-1 font-mono text-[0.7em] text-amber-950 no-underline"
          >
            {s.code}
          </abbr>
        ),
      )}
    </>
  );
}
