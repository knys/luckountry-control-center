import type { ProductsManifest } from "./products.js";
import { IssueSyncService, type IssueSource, type WorkItemRepository } from "./application/issue-sync-service.js";
import { IssuePollingRuntime, pollIntervalFromEnvironment, type Scheduler } from "./application/issue-polling-runtime.js";
import { GitHubIssueAdapter } from "./infrastructure/github-issue-adapter.js";
import { DurableWorkItemRepository, workItemDatabasePath } from "./infrastructure/durable-work-item-repository.js";

export function discoverRepositories(manifest: ProductsManifest): string[] {
  return [...new Set(manifest.products.flatMap((product) => product.repository ? [product.repository] : []))];
}

export interface CompositionDependencies {
  openRepository?: (path: string) => Promise<WorkItemRepository>;
  source?: IssueSource;
  scheduler?: Scheduler;
}

export interface IssueRuntimeComposition { repository: WorkItemRepository; adapter: GitHubIssueAdapter | IssueSource; syncService: IssueSyncService; runtime: IssuePollingRuntime }

export async function composeIssueRuntime(manifest: ProductsManifest, environment: NodeJS.ProcessEnv = process.env, dependencies: CompositionDependencies = {}): Promise<IssueRuntimeComposition> {
  const repository = await (dependencies.openRepository ?? DurableWorkItemRepository.open)(workItemDatabasePath(environment));
  const adapter = dependencies.source ?? new GitHubIssueAdapter(fetch, environment.GITHUB_TOKEN);
  const syncService = new IssueSyncService(adapter, repository);
  const runtime = new IssuePollingRuntime(discoverRepositories(manifest), syncService, pollIntervalFromEnvironment(environment), dependencies.scheduler);
  return { repository, adapter, syncService, runtime };
}
