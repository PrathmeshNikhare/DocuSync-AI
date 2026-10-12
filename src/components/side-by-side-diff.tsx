import { sideBySideRows, type DiffCell } from "@/lib/review/diff-rows";
import { VisibleText } from "./visible-text";

function Cell({ cell, side }: { cell?: DiffCell; side: "left" | "right" }) {
  const changed =
    cell?.changed &&
    (side === "left"
      ? "bg-red-50 dark:bg-red-950"
      : "bg-emerald-50 dark:bg-emerald-950");
  return (
    <>
      <td className="w-12 border-r border-neutral-200 pr-2 text-right align-top text-neutral-500 select-none dark:border-neutral-800">
        {cell?.n}
      </td>
      <td
        className={`px-2 align-top whitespace-pre-wrap break-words ${changed || ""}`}
      >
        {cell && (
          <>
            {cell.changed && (
              <span className="sr-only">
                {side === "left" ? "Removed: " : "Added: "}
              </span>
            )}
            <span aria-hidden="true">
              {cell.changed ? (side === "left" ? "− " : "+ ") : "  "}
            </span>
            <VisibleText text={cell.text} />
          </>
        )}
      </td>
    </>
  );
}

/**
 * The original document and the patched result, side by side. Unchanged stretches
 * between changes are collapsed. Everything is plain text; Markdown is not rendered.
 */
export function SideBySideDiff({
  path,
  original,
  patch,
}: {
  path: string;
  original: string;
  patch: string;
}) {
  const rows = sideBySideRows(path, original, patch);
  if (!rows) {
    return (
      <pre className="overflow-x-auto rounded border border-neutral-200 p-3 font-mono text-xs dark:border-neutral-800">
        <VisibleText text={patch} />
      </pre>
    );
  }
  return (
    <div className="overflow-x-auto rounded border border-neutral-200 dark:border-neutral-800">
      <table className="w-full min-w-[44rem] table-fixed font-mono text-xs">
        <caption className="sr-only">
          Original document on the left, proposed version on the right
        </caption>
        <colgroup>
          <col className="w-12" />
          <col />
          <col className="w-12" />
          <col />
        </colgroup>
        <thead className="border-b border-neutral-200 bg-neutral-50 font-sans text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300">
          <tr>
            <th
              scope="col"
              colSpan={2}
              className="px-2 py-1 text-left font-medium"
            >
              Original
            </th>
            <th
              scope="col"
              colSpan={2}
              className="px-2 py-1 text-left font-medium"
            >
              Proposed
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) =>
            row.kind === "gap" ? (
              <tr
                key={i}
                className="bg-neutral-50 font-sans text-neutral-600 dark:bg-neutral-900 dark:text-neutral-400"
              >
                <td colSpan={4} className="px-2 py-1 text-center">
                  {row.lines} unchanged {row.lines === 1 ? "line" : "lines"}
                </td>
              </tr>
            ) : (
              <tr
                key={i}
                className="border-b border-neutral-100 last:border-0 dark:border-neutral-900"
              >
                <Cell cell={row.left} side="left" />
                <Cell cell={row.right} side="right" />
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}
