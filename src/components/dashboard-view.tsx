import Link from "next/link";
import type { Dashboard } from "@/lib/review/queries";
import { EmptyState, Notice, Tag, formatTime, linkClass, shortSha } from "./ui";

export function DashboardView({ dashboard }: { dashboard: Dashboard }) {
  if (dashboard.repositories.length === 0) {
    return (
      <EmptyState title="No repositories yet">
        <p>
          You don&apos;t have access to any repository. An operator grants
          access with{" "}
          <code>
            npm run reviewer:grant -- --username &lt;you&gt; --repo
            &lt;owner&gt;/&lt;repo&gt;
          </code>
          .
        </p>
      </EmptyState>
    );
  }
  const failed = dashboard.analyses.filter((a) => a.status === "failed").length;
  return (
    <div className="space-y-8">
      <section aria-labelledby="repos-heading">
        <h2 id="repos-heading" className="text-lg font-semibold">
          Repositories
        </h2>
        <ul className="mt-2 flex flex-wrap gap-2">
          {dashboard.repositories.map((r) => (
            <li
              key={r.id}
              className="flex items-center gap-2 rounded border border-neutral-200 px-3 py-1.5 text-sm dark:border-neutral-800"
            >
              <span className="font-mono">
                {r.owner}/{r.name}
              </span>
              {r.source === "fixture" && <Tag>Fixture data</Tag>}
              <span className="text-neutral-600 dark:text-neutral-400">
                {r.analyses} {r.analyses === 1 ? "analysis" : "analyses"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="analyses-heading" className="space-y-3">
        <h2 id="analyses-heading" className="text-lg font-semibold">
          Recent analyses
        </h2>
        {failed > 0 && (
          <Notice
            tone="error"
            title={`${failed} recent ${failed === 1 ? "analysis" : "analyses"} failed`}
          >
            Open a failed analysis to see its error code.
          </Notice>
        )}
        {dashboard.analyses.length === 0 ? (
          <EmptyState title="No analyses yet">
            <p>
              Analyses appear here after a pull request is analysed. To try the
              review flow with a labelled fixture, run{" "}
              <code>npm run analysis:run -- --fixture &lt;name&gt;</code>.
            </p>
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <caption className="sr-only">
                Recent analyses, newest first
              </caption>
              <thead className="border-b border-neutral-300 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Pull request
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Status
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Flagged docs
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Proposals decided
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Created
                  </th>
                </tr>
              </thead>
              <tbody>
                {dashboard.analyses.map((a) => (
                  <tr
                    key={a.id}
                    className="border-b border-neutral-200 dark:border-neutral-800"
                  >
                    <th scope="row" className="py-2 pr-4 font-normal">
                      <Link href={`/analyses/${a.id}`} className={linkClass}>
                        {a.repository.owner}/{a.repository.name} #{a.prNumber}
                      </Link>{" "}
                      <span className="font-mono text-xs text-neutral-600 dark:text-neutral-400">
                        @ {shortSha(a.headSha)}
                      </span>{" "}
                      {a.repository.source === "fixture" && <Tag>Fixture</Tag>}
                    </th>
                    <td className="py-2 pr-4">
                      {a.status}
                      {a.errorCode && (
                        <span className="ml-1 font-mono text-xs">
                          ({a.errorCode})
                        </span>
                      )}
                      {a.modelStatus && a.modelStatus !== "ok" && (
                        <span className="block text-xs text-neutral-600 dark:text-neutral-400">
                          model: {a.modelStatus.replace("_", " ")}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-4">
                      {a.flagged} of {a.candidates}
                    </td>
                    <td className="py-2 pr-4">
                      {a.decided} of {a.proposals}
                    </td>
                    <td className="py-2 whitespace-nowrap">
                      {formatTime(a.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
