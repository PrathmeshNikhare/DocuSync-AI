// Types shared by the webhook receiver (producer) and the database layer
// (persistence), so neither depends on the other.

/** One unit of analysis work: a specific head commit of a pull request. */
export interface PullRequestWork {
  githubRepoId: number;
  owner: string;
  repo: string;
  installationId: number;
  prNumber: number;
  headSha: string;
  baseSha: string;
}

export interface EnqueueResult {
  analysisId: string;
  created: boolean;
}
