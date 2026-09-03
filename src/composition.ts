import type { ProductsManifest } from "./products.js";
import { IssueSyncService, type IssueSource, type WorkItemRepository } from "./application/issue-sync-service.js";
import { IssuePollingRuntime, pollIntervalFromEnvironment, type Scheduler } from "./application/issue-polling-runtime.js";
import { GitHubIssueAdapter } from "./infrastructure/github-issue-adapter.js";
import { DurableWorkItemRepository, workItemDatabasePath } from "./infrastructure/durable-work-item-repository.js";
import { ExecutionService, type ExecutionRepository, type RepositoryExecutionTarget } from "./application/execution.js";
import { ExecutionScanner, workExecutionEnabled } from "./application/execution-scanner.js";
import { RemoteCodexExecutor, RemoteWorkerRegistry, type RemoteWorkerConfig } from "./infrastructure/remote-execution.js";
import { ExecutionReconciler } from "./application/execution-reconciler.js";

export function discoverRepositories(manifest: ProductsManifest): string[] {
  return [...new Set(manifest.products.flatMap((product) => product.repository ? [product.repository] : []))];
}

export interface CompositionDependencies {
  openRepository?: (path: string) => Promise<WorkItemRepository>;
  source?: IssueSource;
  scheduler?: Scheduler;
}

export interface IssueRuntimeComposition { repository: WorkItemRepository & Partial<ExecutionRepository>; adapter: GitHubIssueAdapter | IssueSource; syncService: IssueSyncService; runtime: IssuePollingRuntime }

export async function composeIssueRuntime(manifest: ProductsManifest, environment: NodeJS.ProcessEnv = process.env, dependencies: CompositionDependencies = {}): Promise<IssueRuntimeComposition> {
  const repository = await (dependencies.openRepository ?? DurableWorkItemRepository.open)(workItemDatabasePath(environment));
  const adapter = dependencies.source ?? new GitHubIssueAdapter(fetch, environment.GITHUB_TOKEN);
  const syncService = new IssueSyncService(adapter, repository);
  const runtime = new IssuePollingRuntime(discoverRepositories(manifest), syncService, pollIntervalFromEnvironment(environment), dependencies.scheduler);
  return { repository: repository as WorkItemRepository & Partial<ExecutionRepository>, adapter, syncService, runtime };
}

export interface ExecutionRuntimeComposition { service: ExecutionService; scanner: ExecutionScanner; reconciler: ExecutionReconciler }
export async function composeExecutionRuntime(repository: WorkItemRepository & ExecutionRepository, repositories: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<ExecutionRuntimeComposition | null> {
  if (!workExecutionEnabled(environment)) return null;
  const workerId=environment.WORKER_ID?.trim(),baseUrl=environment.WORKER_URL?.trim(),keyId=environment.WORKER_HMAC_KEY_ID?.trim(),secret=environment.WORKER_HMAC_SECRET;
  let targets:RepositoryExecutionTarget[];try{targets=JSON.parse(environment.WORK_EXECUTION_TARGETS_JSON??"") as RepositoryExecutionTarget[];}catch{return null;}
  if(!workerId||!baseUrl||!keyId||!secret||!Array.isArray(targets)||targets.length===0||targets.some(target=>!repositories.includes(target.repository)||target.workerId!==workerId||!target.workspaceId||target.concurrency!=="EXCLUSIVE_REPOSITORY"))return null;
  const remotes:RemoteWorkerConfig[]=[{workerId,baseUrl,credentials:{keyId,secret}}];const registry=new RemoteWorkerRegistry(remotes);const executor=new RemoteCodexExecutor(remotes,repositoryName=>targets.find(target=>target.repository===repositoryName)?.workerId??null);const service=new ExecutionService(repository,targets,registry,executor);const scanner=new ExecutionScanner(repository,service,true,async()=>(await Promise.all(repositories.map(name=>repository.list(name)))).flat().map(item=>item.id));const reconciler=new ExecutionReconciler(repository,executor);await reconciler.reconcile();return{service,scanner,reconciler};
}
