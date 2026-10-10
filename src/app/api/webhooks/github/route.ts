import { enqueueAnalysis } from "@/lib/db/analyses";
import { getPool } from "@/lib/db/pool";
import { getWebhookConfig } from "@/lib/env";
import { handleGitHubWebhook } from "@/lib/github/webhook-handler";

export function POST(request: Request) {
  return handleGitHubWebhook(request, {
    getConfig: () => getWebhookConfig(),
    enqueue: (work, key, deliveryId) =>
      enqueueAnalysis(getPool(), work, key, deliveryId),
  });
}
