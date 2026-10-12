import { Suspense } from "react";
import { DashboardView } from "@/components/dashboard-view";
import { LoadingState } from "@/components/ui";
import { getPool } from "@/lib/db/pool";
import { requireReviewer } from "@/lib/review/auth";
import { getDashboard } from "@/lib/review/queries";

export default function Home() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Documentation reviews</h1>
      <Suspense fallback={<LoadingState label="Loading your analyses" />}>
        <Dashboard />
      </Suspense>
    </div>
  );
}

async function Dashboard() {
  const reviewer = await requireReviewer();
  return (
    <DashboardView dashboard={await getDashboard(getPool(), reviewer.id)} />
  );
}
