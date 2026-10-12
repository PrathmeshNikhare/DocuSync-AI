import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ReviewView } from "@/components/review-view";
import { LoadingState } from "@/components/ui";
import { getPool } from "@/lib/db/pool";
import { requireReviewer } from "@/lib/review/auth";
import { codeOnlyErrors } from "@/lib/review/safe";
import { getReview } from "@/lib/review/queries";

export default function ReviewPage({ params }: PageProps<"/reviews/[id]">) {
  return (
    <Suspense fallback={<LoadingState label="Loading the proposed patch" />}>
      <Review params={params} />
    </Suspense>
  );
}

async function Review({ params }: Pick<PageProps<"/reviews/[id]">, "params">) {
  return codeOnlyErrors("page_review", async () => {
    const reviewer = await requireReviewer();
    const review = await getReview(getPool(), reviewer.id, (await params).id);
    if (!review) notFound();
    return <ReviewView review={review} />;
  });
}
