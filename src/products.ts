import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const productStatuses = ["RUNNING", "QUEUED", "READY", "WAITING", "BLOCKED", "ACCEPTANCE", "DONE", "UNKNOWN"] as const;
export const productBalls = ["CHATGPT", "CODEX", "LCC", "HUMAN", "EXTERNAL", "NONE", "UNKNOWN"] as const;
export type ProductState = typeof productStatuses[number];
export type ProductBall = typeof productBalls[number];

export interface ProductManifestItem { id: string; name: string; repository: string | null; summary: string; status: ProductState; ball: ProductBall; nextAction: string; workItemMatch?:string[] }
export interface ProductsManifest { version: 1; products: ProductManifestItem[] }
export interface GitHubMetadata { repository: string; repositoryUrl: string; defaultBranch: string | null; headSha: string | null; openIssues: number; openPullRequests: number; updatedAt: string }
export interface ProductStatus extends ProductManifestItem { repositoryUrl: string | null; defaultBranch: string | null; headSha: string | null; openIssues: number | null; openPullRequests: number | null; updatedAt: string | null; source: "manifest" | "manifest+github"; stale: boolean; activeActor:string|null;currentRun:string|null;blocker:string|null;humanGate:string|null;latestGitHubEvidence:string|null }
export interface ProductsResponse { timestamp: string; cacheUpdatedAt: string | null; stale: boolean; warning: string | null; products: ProductStatus[] }
export interface GitHubMetadataProvider { fetch(repositories: readonly string[]): Promise<Map<string, GitHubMetadata>> }

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseProductsManifest(value: unknown): ProductsManifest {
  const root = record(value);
  if (!root || root.version !== 1 || !Array.isArray(root.products)) throw new Error("invalid products manifest root");
  const ids = new Set<string>();
  const products = root.products.map((raw, index): ProductManifestItem => {
    const item = record(raw);
    if (!item || !nonEmpty(item.id) || !/^[a-z0-9-]+$/.test(item.id) || ids.has(item.id)) throw new Error(`invalid or duplicate product id at index ${index}`);
    ids.add(item.id);
    if (!nonEmpty(item.name) || !nonEmpty(item.summary) || !nonEmpty(item.nextAction)) throw new Error(`invalid product text at index ${index}`);
    if (!productStatuses.includes(item.status as ProductState)) throw new Error(`invalid product status at index ${index}`);
    if (!productBalls.includes(item.ball as ProductBall)) throw new Error(`invalid product ball at index ${index}`);
    if (item.repository !== null && (!nonEmpty(item.repository) || !repositoryPattern.test(item.repository))) throw new Error(`invalid repository at index ${index}`);
    const workItemMatch=item.workItemMatch;
    if(workItemMatch!==undefined&&(!Array.isArray(workItemMatch)||workItemMatch.length===0||workItemMatch.some(value=>!nonEmpty(value)||value.length>100)))throw new Error(`invalid work item match at index ${index}`);
    return { id: item.id, name: item.name, repository: item.repository as string | null, summary: item.summary, status: item.status as ProductState, ball: item.ball as ProductBall, nextAction: item.nextAction,...(workItemMatch?{workItemMatch:[...workItemMatch]}:{}) };
  });
  return { version: 1, products };
}

export function parseGitHubMetadata(value: unknown, aliases: ReadonlyMap<string, string>): Map<string, GitHubMetadata> {
  const data = record(record(value)?.data);
  if (!data) throw new Error("invalid GitHub response");
  const output = new Map<string, GitHubMetadata>();
  for (const [alias, repository] of aliases) {
    const repo = record(data[alias]);
    if (!repo || !nonEmpty(repo.url) || !nonEmpty(repo.updatedAt)) continue;
    const branch = record(repo.defaultBranchRef);
    const target = record(branch?.target);
    const issues = record(repo.issues);
    const pulls = record(repo.pullRequests);
    if (typeof issues?.totalCount !== "number" || typeof pulls?.totalCount !== "number") continue;
    output.set(repository, { repository, repositoryUrl: repo.url, defaultBranch: nonEmpty(branch?.name) ? branch.name : null, headSha: nonEmpty(target?.oid) ? target.oid : null, openIssues: issues.totalCount, openPullRequests: pulls.totalCount, updatedAt: repo.updatedAt });
  }
  return output;
}

export class GhCliMetadataProvider implements GitHubMetadataProvider {
  async fetch(repositories: readonly string[]): Promise<Map<string, GitHubMetadata>> {
    const aliases = new Map<string, string>();
    const fields = repositories.map((repository, index) => {
      if (!repositoryPattern.test(repository)) throw new Error("repository is not allowlisted safely");
      const [owner, name] = repository.split("/") as [string, string];
      const alias = `r${index}`;
      aliases.set(alias, repository);
      return `${alias}:repository(owner:${JSON.stringify(owner)},name:${JSON.stringify(name)}){url updatedAt defaultBranchRef{name target{... on Commit{oid}}} issues(states:OPEN){totalCount} pullRequests(states:OPEN){totalCount}}`;
    });
    if (fields.length === 0) return new Map();
    const { stdout } = await execFileAsync("gh", ["api", "graphql", "-f", `query=query{${fields.join(" ")}}`], { timeout: 15_000, maxBuffer: 1024 * 1024 });
    return parseGitHubMetadata(JSON.parse(stdout), aliases);
  }
}

export interface PortfolioWork {id:string;source:{repository:string;externalId:string};title:string;sourceUrl:string;workState:string;ballHolder:string;nextAction:{summary:string};blocker:string|null;evidence:string[]}
export interface PortfolioExecution {executionId:string;workItemId:string;resultStatus:string;startedAt:string;finishedAt:string|null;summary:string}
export interface PortfolioState {workItems:PortfolioWork[];executions:PortfolioExecution[]}
export class ProductService {
  private metadata = new Map<string, GitHubMetadata>();
  private cacheUpdatedAt: string | null = null;
  private lastAttempt = Number.NEGATIVE_INFINITY;
  private warning: string | null = null;
  private refreshing: Promise<void> | null = null;
  constructor(readonly manifest: ProductsManifest, private readonly provider: GitHubMetadataProvider, private readonly ttlMs = 60_000, private readonly now: () => number = Date.now,private readonly portfolio?:()=>Promise<PortfolioState>) {}

  private async refresh(): Promise<void> {
    this.lastAttempt = this.now();
    try {
      const repositories = [...new Set(this.manifest.products.flatMap((product) => product.repository ? [product.repository] : []))];
      this.metadata = await this.provider.fetch(repositories);
      this.cacheUpdatedAt = new Date(this.now()).toISOString();
      this.warning = null;
    } catch {
      this.warning = "GitHub metadata unavailable; showing the last cached data";
    }
  }

  async getProducts(): Promise<ProductsResponse> {
    if (this.now() - this.lastAttempt >= this.ttlMs) {
      this.refreshing ??= this.refresh().finally(() => { this.refreshing = null; });
      await this.refreshing;
    }
    const stale = this.warning !== null;
    const portfolio=await this.portfolio?.().catch(()=>undefined);
    return { timestamp: new Date(this.now()).toISOString(), cacheUpdatedAt: this.cacheUpdatedAt, stale, warning: this.warning, products: this.manifest.products.map((product) => {
      const github = product.repository ? this.metadata.get(product.repository) : undefined;
      const candidates=portfolio?.workItems.filter(value=>value.source.repository===product.repository&&matchesProductWorkItem(product,value))??[],rank=(value:PortfolioWork)=>["RUNNING","VERIFYING","RETRYING","READY","WAITING_WORKER","WAITING_HUMAN","BLOCKED","FAILED","DEFINED","DONE"].indexOf(value.workState),work=[...candidates].sort((a,b)=>rank(a)-rank(b))[0],execution=work?[...(portfolio?.executions??[])].reverse().find(value=>value.workItemId===work.id&&["ACTIVE"].includes(value.resultStatus)):undefined,derivedStatus:ProductState|undefined=execution?"RUNNING":work?.workState==="READY"||work?.workState==="RETRYING"?"QUEUED":work?.workState==="WAITING_HUMAN"?"ACCEPTANCE":work?.workState==="BLOCKED"||work?.workState==="FAILED"?"BLOCKED":undefined;
      return { ...product,...(derivedStatus?{status:derivedStatus}:{}),...(work?{ball:(execution?"CODEX":work.ballHolder) as ProductBall,nextAction:work.nextAction.summary}:{}), repositoryUrl: github?.repositoryUrl ?? null, defaultBranch: github?.defaultBranch ?? null, headSha: github?.headSha ?? null, openIssues: github?.openIssues ?? null, openPullRequests: github?.openPullRequests ?? null, updatedAt: github?.updatedAt ?? null, source: github ? "manifest+github" : "manifest", stale: stale || (!!product.repository && !github),activeActor:execution?"CODEX":null,currentRun:execution?.executionId??null,blocker:work?.blocker??(work?.workState==="FAILED"?work.nextAction.summary:null),humanGate:work?.workState==="WAITING_HUMAN"?work.nextAction.summary:null,latestGitHubEvidence:work?.sourceUrl??github?.repositoryUrl??null };
    }) };
  }
}
function matchesProductWorkItem(product:ProductManifestItem,work:PortfolioWork):boolean{if(!product.workItemMatch)return true;const haystack=`${work.title} ${work.id}`.toLocaleLowerCase();return product.workItemMatch.some(value=>haystack.includes(value.toLocaleLowerCase()));}
