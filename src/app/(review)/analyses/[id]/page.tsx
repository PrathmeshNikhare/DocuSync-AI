import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AnalysisView } from "@/components/analysis-view";
import { LoadingState } from "@/components/ui";
import { getPool } from "@/lib/db/pool";
import { requireReviewer } from "@/lib/review/auth";
import { getAnalysis } from "@/lib/review/queries";

export default function AnalysisPage({ params }: PageProps<"/analyses/[id]">) {
  return (
    <Suspense fallback={<LoadingState label="Loading the analysis" />}>
      <Analysis params={params} />
    </Suspense>
  );
}

async function Analysis({
  params,
}: Pick<PageProps<"/analyses/[id]">, "params">) {
  const reviewer = await requireReviewer();
  // Missing and not-authorized look the same (no existence leak).
  const analysis = await getAnalysis(getPool(), reviewer.id, (await params).id);
  if (!analysis) notFound();
  return <AnalysisView analysis={analysis} />;
}
