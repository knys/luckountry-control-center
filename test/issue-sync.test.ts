import test from "node:test";
import assert from "node:assert/strict";
import { GitHubIssueAdapter } from "../src/infrastructure/github-issue-adapter.js";
import { InMemoryWorkItemRepository } from "../src/infrastructure/in-memory-work-item-repository.js";
import { IssueSyncService, SyncFailure, type ExternalIssue, type IssueSource, type WorkItemRepository } from "../src/application/issue-sync-service.js";

const repositoryName = "knys/luckountry-control-center";
const attemptedAt = "2026-09-03T01:02:03.000Z";
const clock = () => Date.parse(attemptedAt);
const issue = (changes: Partial<ExternalIssue> = {}): ExternalIssue => ({ externalId: "1", title: "Build issue sync", state: "open", labels: ["feature"], assignees: ["knys"], updatedAt: "2026-09-02T12:00:00Z", url: "https://github.com/knys/luckountry-control-center/issues/1", ...changes });
const source = (items: ExternalIssue[] = [issue()]): IssueSource => ({ fetchOpenIssues: async () => items });
const sync = (provider: IssueSource, repository = new InMemoryWorkItemRepository()) => ({ service: new IssueSyncService(provider, repository, clock), repository });

test("T01 fetch_open_issues", async () => {
  let requested = "";
  const adapter = new GitHubIssueAdapter(async (input) => {
    requested = String(input);
    return new Response(JSON.stringify([
      { number: 1, title: "Issue", state: "open", labels: [{ name: "feature" }], assignees: [{ login: "knys" }], updated_at: "2026-09-02T12:00:00Z", html_url: "https://github.com/knys/repo/issues/1" },
      { number: 2, title: "PR", state: "open", labels: [], assignees: [], updated_at: "2026-09-02T12:00:00Z", html_url: "https://github.com/knys/repo/pull/2", pull_request: {} }
    ]), { status: 200, headers: { "content-type": "application/json" } });
  });
  const result = await adapter.fetchOpenIssues("knys/repo");
  assert.match(requested, /repos\/knys\/repo\/issues\?state=open/);
  assert.deepEqual(result, [{ externalId: "1", title: "Issue", state: "open", labels: ["feature"], assignees: ["knys"], updatedAt: "2026-09-02T12:00:00Z", url: "https://github.com/knys/repo/issues/1",body:null }]);
});

test("T02 map_issue_fields", async () => {
  const { service } = sync(source());
  const [item] = await service.sync(repositoryName);
  assert.deepEqual(item, { id: `github:${repositoryName}:1`, source: { provider: "github", repository: repositoryName, externalId: "1" }, title: "Build issue sync", sourceState: "open", labels: ["feature"], assignees: ["knys"], sourceUrl: issue().url, workState: "DEFINED", ballHolder: "HUMAN", nextAction: { kind: "DEFINE", summary: "Complete the definition and Coding Ready Gate", ballHolder: "HUMAN", aiExecutable: false, requiredCapabilities: [] }, blocker: null, acceptanceCriteria: [], evidence: [], sourceUpdatedAt: issue().updatedAt, lastSyncedAt: attemptedAt, transitionReason: "Source discovered; explicit definition completion is required" });
});

test("T03 empty_repository", async () => {
  const { service, repository } = sync(source());
  await service.sync(repositoryName);
  assert.equal((await repository.list(repositoryName)).length, 1);
});

test("T04 no_duplicate", async () => {
  const { service, repository } = sync(source());
  await service.sync(repositoryName);
  await service.sync(repositoryName);
  assert.equal((await repository.list(repositoryName)).length, 1);
});

test("T05 update_existing", async () => {
  let title = "First";
  const provider: IssueSource = { fetchOpenIssues: async () => [issue({ title })] };
  const { service, repository } = sync(provider);
  await service.sync(repositoryName);
  title = "Changed upstream";
  await service.sync(repositoryName);
  assert.equal((await repository.list(repositoryName))[0]?.title, title);
});

test("T06 network_failure_preserves_data", async () => {
  let fails = false;
  const provider: IssueSource = { fetchOpenIssues: async () => { if (fails) throw new SyncFailure("NETWORK", "offline"); return [issue()]; } };
  const { service, repository } = sync(provider);
  await service.sync(repositoryName);
  const before = await repository.list(repositoryName);
  fails = true;
  await assert.rejects(service.sync(repositoryName), (error: unknown) => error instanceof SyncFailure && error.failureType === "NETWORK");
  assert.deepEqual(await repository.list(repositoryName), before);
});

for (const [name, status, expected] of [["T07 unauthorized", 401, "AUTHENTICATION"], ["T08 forbidden", 403, "AUTHORIZATION"], ["T09 rate_limit", 429, "RATE_LIMIT"]] as const) {
  test(name, async () => {
    const adapter = new GitHubIssueAdapter(async () => new Response("failure", { status, headers: status === 429 ? { "x-ratelimit-reset": "1788400000", "retry-after": "60" } : {} }));
    await assert.rejects(adapter.fetchOpenIssues(repositoryName), (error: unknown) => {
      if (!(error instanceof SyncFailure) || error.failureType !== expected) return false;
      if (status === 429) {
        assert.equal(error.retryAfter, 60);
        assert.equal(error.resetAt, new Date(1788400000 * 1000).toISOString());
      }
      return true;
    });
  });
}

test("T10 sync_success_metadata", async () => {
  const { service, repository } = sync(source());
  await service.sync(repositoryName);
  assert.deepEqual(await repository.metadata(repositoryName), { status: "SUCCEEDED", lastAttemptedSyncAt: attemptedAt, lastSuccessfulSyncAt: attemptedAt, failureReason: null, failureType: null, resetAt: null, retryAfter: null });
});

test("T11 sync_failure_metadata", async () => {
  const repo = new InMemoryWorkItemRepository();
  const first = new IssueSyncService(source(), repo, () => Date.parse("2026-09-01T00:00:00Z"));
  await first.sync(repositoryName);
  const failed = new IssueSyncService({ fetchOpenIssues: async () => { throw new SyncFailure("NETWORK", "connection reset"); } }, repo, clock);
  await assert.rejects(failed.sync(repositoryName));
  const metadata = await repo.metadata(repositoryName);
  assert.equal(metadata.status, "FAILED");
  assert.equal(metadata.lastAttemptedSyncAt, attemptedAt);
  assert.equal(metadata.lastSuccessfulSyncAt, "2026-09-01T00:00:00.000Z");
  assert.equal(metadata.failureType, "NETWORK");
  assert.match(metadata.failureReason ?? "", /connection reset/);
});

test("T12 malformed_response", async () => {
  const adapter = new GitHubIssueAdapter(async () => new Response(JSON.stringify([{ number: 1, state: "open" }]), { status: 200 }));
  await assert.rejects(adapter.fetchOpenIssues(repositoryName), (error: unknown) => error instanceof SyncFailure && error.failureType === "INVALID_RESPONSE");
});

test("T13 partial_failure_atomicity", async () => {
  const repo = new InMemoryWorkItemRepository();
  await new IssueSyncService(source([issue({ externalId: "9", title: "Existing" })]), repo, clock).sync(repositoryName);
  const before = await repo.list(repositoryName);
  const invalid = issue({ externalId: "2", updatedAt: "not-a-date" });
  await assert.rejects(new IssueSyncService(source([issue(), invalid]), repo, clock).sync(repositoryName));
  assert.deepEqual(await repo.list(repositoryName), before);
});

test("T14 integration_github", { skip: process.env.LCC_GITHUB_INTEGRATION !== "1" }, async () => {
  const adapter = new GitHubIssueAdapter(fetch, process.env.GITHUB_TOKEN);
  const issues = await adapter.fetchOpenIssues(repositoryName);
  assert.ok(issues.every((item) => item.state === "open" && item.url.startsWith(`https://github.com/${repositoryName}/issues/`)));
});

test("repository commit is atomic when persistence throws", async () => {
  const backing = new InMemoryWorkItemRepository();
  await new IssueSyncService(source([issue({ externalId: "9" })]), backing, clock).sync(repositoryName);
  const failing: WorkItemRepository = { list: (name) => backing.list(name), metadata: (name) => backing.metadata(name), recordFailure: (name, value) => backing.recordFailure(name, value), commitSync: async () => { throw new Error("disk full"); }, transitionExecutionState: (id, update) => backing.transitionExecutionState(id, update) };
  await assert.rejects(new IssueSyncService(source(), failing, clock).sync(repositoryName));
  assert.equal((await backing.list(repositoryName))[0]?.source.externalId, "9");
});

test("LCC-007 V01 GitHub body is fetched and Acceptance is ingested",async()=>{const adapter=new GitHubIssueAdapter(async()=>new Response(JSON.stringify([{number:14,title:"Verify",state:"open",labels:[],assignees:[],updated_at:issue().updatedAt,html_url:issue().url,body:"## Acceptance Criteria\n- [x] AC-01 [AUTO:test] tests"}]),{status:200}));const {service}=sync(adapter);const [item]=await service.sync(repositoryName);assert.deepEqual(item?.acceptanceCriteria,["AC-01 [AUTO:test] tests"]);});
test("LCC-007 V06 source Acceptance updates without losing execution state or evidence",async()=>{let body="## Acceptance Criteria\n- [ ] AC-01 [AUTO:test] old";const provider:IssueSource={fetchOpenIssues:async()=>[issue({body})]};const {service,repository}=sync(provider);const [first]=await service.sync(repositoryName);await repository.transitionExecutionState(first!.id,item=>({...item,workState:"RUNNING",ballHolder:"CODEX",evidence:["execution"]}));body="## Acceptance Criteria\n- [ ] AC-02 [AUTO:build] new";const [updated]=await service.sync(repositoryName);assert.deepEqual(updated?.acceptanceCriteria,["AC-02 [AUTO:build] new"]);assert.equal(updated?.workState,"RUNNING");assert.deepEqual(updated?.evidence,["execution"]);});
