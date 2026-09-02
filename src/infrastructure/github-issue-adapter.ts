import { SyncFailure, type ExternalIssue, type IssueSource } from "../application/issue-sync-service.js";

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown): value is string => typeof value === "string" && value.length > 0;

export class GitHubIssueAdapter implements IssueSource {
  constructor(private readonly request: typeof fetch = fetch, private readonly token?: string) {}

  async fetchOpenIssues(repository: string): Promise<ExternalIssue[]> {
    if (!repositoryPattern.test(repository)) throw new SyncFailure("INVALID_RESPONSE", "invalid repository name");
    const output: ExternalIssue[] = [];
    let url: string | null = `https://api.github.com/repos/${repository}/issues?state=open&per_page=100`;
    while (url) {
      let response: Response;
      try {
        const headers: Record<string, string> = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
        if (this.token) headers.authorization = `Bearer ${this.token}`;
        response = await this.request(url, { headers, signal: AbortSignal.timeout(15_000) });
      } catch (error) {
        throw new SyncFailure("NETWORK", error instanceof Error ? error.message : "GitHub network failure");
      }
      if (!response.ok) throw responseFailure(response);
      let payload: unknown;
      try { payload = await response.json(); } catch { throw new SyncFailure("INVALID_RESPONSE", "GitHub returned invalid JSON"); }
      if (!Array.isArray(payload)) throw new SyncFailure("INVALID_RESPONSE", "GitHub issue response is not an array");
      for (const raw of payload) {
        const item = parseIssue(raw);
        if (item) output.push(item);
      }
      url = nextLink(response.headers.get("link"));
    }
    return output;
  }
}

function parseIssue(value: unknown): ExternalIssue | null {
  const item = object(value);
  if (!item) throw new SyncFailure("INVALID_RESPONSE", "GitHub issue entry is not an object");
  if (item.pull_request !== undefined) return null;
  const labels = item.labels;
  const assignees = item.assignees;
  if (typeof item.number !== "number" || !Number.isInteger(item.number) || item.number <= 0 || !string(item.title) || item.state !== "open" || !string(item.updated_at) || !string(item.html_url) || !Array.isArray(labels) || !Array.isArray(assignees)) {
    throw new SyncFailure("INVALID_RESPONSE", "GitHub issue entry has invalid fields");
  }
  const parsedLabels = labels.map((label) => typeof label === "string" ? label : object(label)?.name);
  const parsedAssignees = assignees.map((assignee) => object(assignee)?.login);
  if (!parsedLabels.every(string) || !parsedAssignees.every(string)) throw new SyncFailure("INVALID_RESPONSE", "GitHub issue labels or assignees are invalid");
  return { externalId: String(item.number), title: item.title, state: item.state, labels: parsedLabels as string[], assignees: parsedAssignees as string[], updatedAt: item.updated_at, url: item.html_url };
}

function responseFailure(response: Response): SyncFailure {
  const retryAfterText = response.headers.get("retry-after");
  const retryAfter = retryAfterText !== null && Number.isFinite(Number(retryAfterText)) ? Number(retryAfterText) : null;
  const resetText = response.headers.get("x-ratelimit-reset");
  const resetAt = resetText !== null && Number.isFinite(Number(resetText)) ? new Date(Number(resetText) * 1000).toISOString() : null;
  if (response.status === 401) return new SyncFailure("AUTHENTICATION", "GitHub authentication failed");
  if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) return new SyncFailure("RATE_LIMIT", "GitHub rate limit exceeded", resetAt, retryAfter);
  if (response.status === 403) return new SyncFailure("AUTHORIZATION", "GitHub authorization failed");
  return new SyncFailure("UNKNOWN", `GitHub request failed with status ${response.status}`);
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const match = part.match(/^\s*<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === "next") return match[1] ?? null;
  }
  return null;
}
