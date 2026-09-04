import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redact } from "./application/verification.js";
import type { SyncMetadata } from "./domain/work-item.js";

const execFileAsync = promisify(execFile);

export const productStatuses = ["RUNNING", "QUEUED", "READY", "WAITING", "BLOCKED", "ACCEPTANCE", "DONE", "UNKNOWN"] as const;
export const productBalls = ["CHATGPT", "CODEX", "LCC", "HUMAN", "EXTERNAL", "NONE", "UNKNOWN"] as const;
export type ProductState = typeof productStatuses[number];
export type ProductBall = typeof productBalls[number];

export interface ProductManifestItem { id: string; name: string; repository: string | null; summary: string; status: ProductState; ball: ProductBall; nextAction: string; workItemMatch?:string[]; primaryIssue?:number; humanActionJa?:string; humanGate?:string; blocker?:string }
export interface ProductsManifest { version: 1; products: ProductManifestItem[] }
export interface GitHubMetadata { repository: string; repositoryUrl: string; defaultBranch: string | null; headSha: string | null; openIssues: number; openPullRequests: number; updatedAt: string }
export interface HumanSourceIdentity {repository:string;issueNumber:number;revision:string}
export interface ProductStatus extends Omit<ProductManifestItem,"humanActionJa"|"humanGate"|"blocker"> { repositoryUrl: string | null; defaultBranch: string | null; headSha: string | null; openIssues: number | null; openPullRequests: number | null; updatedAt: string | null; source: "manifest" | "manifest+github"; stale: boolean; syncWarning:string|null;issueNumber:number|null;issueTitle:string|null;issueUrl:string|null;relatedIssues:{number:number;url:string;title:string;state:string}[];relatedPullRequests:{number:number;url:string}[];nextActionJa:string;humanActionJa:string|null;humanSource:HumanSourceIdentity|null;activeActor:string|null;queuedActor:string|null;currentRun:string|null;executionId:string|null;baseSha:string|null;candidateSha:string|null;deployedSha:string|null;blocker:string|null;humanGate:string|null;failureSummary:string|null;latestVerificationSummary:string|null;latestGitHubEvidence:string|null }
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
    const primaryIssue=item.primaryIssue,humanActionJa=item.humanActionJa,humanGate=item.humanGate,blocker=item.blocker;
    if(primaryIssue!==undefined&&(typeof primaryIssue!=="number"||!Number.isSafeInteger(primaryIssue)||primaryIssue<1))throw new Error(`invalid primary issue at index ${index}`);
    for(const field of ["humanActionJa","humanGate","blocker"] as const)if(item[field]!==undefined&&!nonEmpty(item[field]))throw new Error(`invalid ${field} at index ${index}`);
    return { id: item.id, name: item.name, repository: item.repository as string | null, summary: item.summary, status: item.status as ProductState, ball: item.ball as ProductBall, nextAction: item.nextAction,...(workItemMatch?{workItemMatch:[...workItemMatch]}:{}),...(typeof primaryIssue==="number"?{primaryIssue}:{}),...(nonEmpty(humanActionJa)?{humanActionJa}:{}),...(nonEmpty(humanGate)?{humanGate}:{}),...(nonEmpty(blocker)?{blocker}:{}) };
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

export interface PortfolioWork {id:string;source:{repository:string;externalId:string};title:string;sourceUrl:string;sourceState?:string;sourceUpdatedAt?:string;workState:string;ballHolder:string;nextAction:{summary:string};blocker:string|null;evidence:string[]}
export interface PortfolioExecution {executionId:string;workItemId:string;resultStatus:string;startedAt:string;finishedAt:string|null;summary:string;evidence?:string[];baseHead?:string;candidateHead?:string}
export interface PortfolioRun {runId:string;workItemId:string}
export interface PortfolioState {workItems:PortfolioWork[];executions:PortfolioExecution[];runs?:PortfolioRun[];syncMetadata?:Record<string,SyncMetadata>}
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
      const candidates=portfolio?.workItems.filter(value=>value.source.repository===product.repository&&matchesProductWorkItem(product,value))??[];
      const active=[...(portfolio?.executions??[])].reverse().find(value=>value.resultStatus==="ACTIVE"&&candidates.some(work=>work.id===value.workItemId));
      const rank=(value:PortfolioWork)=>["RUNNING","VERIFYING","RETRYING","READY","WAITING_WORKER","WAITING_HUMAN","BLOCKED","FAILED","DEFINED","DONE"].indexOf(value.workState);
      const work=(active?candidates.find(value=>value.id===active.workItemId):undefined)??candidates.find(value=>Number(value.source.externalId)===product.primaryIssue)??[...candidates].sort((a,b)=>rank(a)-rank(b))[0];
      const sync=product.repository?portfolio?.syncMetadata?.[product.repository]:undefined;
      const syncFailed=sync?.status==="FAILED";
      const configuredHuman=product.ball==="HUMAN"&&product.status==="ACCEPTANCE"&&!!product.humanActionJa&&!!product.humanGate;
      const primaryOpen=product.primaryIssue!==undefined&&candidates.some(value=>Number(value.source.externalId)===product.primaryIssue&&value.sourceState!=="closed");
      const explicitHuman=!syncFailed&&primaryOpen&&configuredHuman;
      const status:ProductState=active&&work?"RUNNING":explicitHuman?"ACCEPTANCE":!syncFailed&&work?.workState==="WAITING_HUMAN"?"ACCEPTANCE":work?.workState==="BLOCKED"||work?.workState==="FAILED"?"BLOCKED":work?"QUEUED":configuredHuman?"READY":product.status==="RUNNING"?"READY":product.status;
      const ball:ProductBall=active&&work?"CODEX":explicitHuman||(!syncFailed&&work?.workState==="WAITING_HUMAN")?"HUMAN":work?((work.ballHolder==="CODEX"?"CODEX":"LCC") as ProductBall):configuredHuman?"LCC":product.ball;
      const issueNumber=work&&/^\d+$/.test(work.source.externalId)?Number(work.source.externalId):product.primaryIssue??null;
      const issueUrl=work?.sourceUrl??(issueNumber&&product.repository?`https://github.com/${product.repository}/issues/${issueNumber}`:null);
      const nextActionJa=deriveNextActionJa(product,work,status,issueNumber,ball);
      const validHumanWork=!syncFailed&&work?.sourceState!=="closed"&&(explicitHuman||work?.workState==="WAITING_HUMAN")?work:undefined;
      const humanActionJa=validHumanWork?(explicitHuman?product.humanActionJa!:`Issue #${issueNumber}「${work!.title}」について、指定された実機または画面で完了条件を確認し、観察結果とPASS/FAILを記録する`):null;
      const humanGate=validHumanWork?(explicitHuman?product.humanGate!:`Issue #${issueNumber}は自動検証後のHuman Acceptanceを必要としている`):null;
      const humanSource=validHumanWork&&product.repository&&issueNumber?{repository:product.repository,issueNumber,revision:validHumanWork.sourceUpdatedAt??validHumanWork.id}:null;
      const syncWarning=syncFailed?`GitHub issue sync failed (${sync.failureType??"UNKNOWN"}); Human Action is hidden until a fresh successful poll`:null;
      const latestExecution=work?[...(portfolio?.executions??[])].reverse().find(value=>value.workItemId===work.id):undefined;
      const currentRun=work?[...(portfolio?.runs??[])].reverse().find(value=>value.workItemId===work.id)?.runId??null:null;
      const rawBlocker=status==="BLOCKED"?(work?.blocker??(latestExecution?`Issue #${issueNumber} / Run ${latestExecution.executionId} ${latestExecution.resultStatus}: ${latestExecution.summary}`:undefined)??product.blocker??(work?`Issue #${issueNumber} が ${work.workState}: ${work.nextAction.summary}`:null)):null;
      const blocker=rawBlocker?redact(rawBlocker,1000):null;
      const relatedIssues=candidates.filter(value=>value!==work).slice(0,20).map(value=>({number:Number(value.source.externalId),url:value.sourceUrl,title:value.title,state:value.workState})).filter(value=>Number.isSafeInteger(value.number));
      const failureSummary=latestExecution&&latestExecution.resultStatus!=="ACTIVE"?redact(`${latestExecution.resultStatus}: ${latestExecution.summary}`,500):null;
      const latestVerificationSummary=work?.evidence.length?work.evidence.slice(-3).map(value=>redact(value,500)).join("\n"):null;
      const evidence=[...(work?.evidence??[]),...(latestExecution?.evidence??[])];
      const relatedPullRequests=extractRelatedPullRequests(evidence,product.repository);
      const baseSha=safeEvidenceSha(latestExecution?.baseHead??findEvidenceValue(evidence,"base(?:Head|Sha)"));
      const candidateSha=safeEvidenceSha(latestExecution?.candidateHead??findEvidenceValue(evidence,"candidate(?:Head|Sha)"));
      const explicitDeployed=safeEvidenceSha(findEvidenceValue(evidence,"deployed(?:Head|Sha)"));
      const deployedSha=explicitDeployed??(candidateSha&&github?.headSha===candidateSha?candidateSha:null);
      return { ...product,status,ball,nextAction:nextActionJa,nextActionJa,humanActionJa,humanSource,issueNumber,issueTitle:work?.title??null,issueUrl,relatedIssues,relatedPullRequests,repositoryUrl: github?.repositoryUrl ?? null, defaultBranch: github?.defaultBranch ?? null, headSha: github?.headSha ?? null, openIssues: github?.openIssues ?? null, openPullRequests: github?.openPullRequests ?? null, updatedAt: github?.updatedAt ?? null, source: github ? "manifest+github" : "manifest", stale: stale || syncFailed || (!!product.repository && !github),syncWarning,activeActor:active&&work?"CODEX":null,queuedActor:status==="QUEUED"?(ball==="CODEX"?"CODEX":"LCC"):null,currentRun,executionId:latestExecution?.executionId??null,baseSha,candidateSha,deployedSha,blocker,humanGate,failureSummary,latestVerificationSummary,latestGitHubEvidence:issueUrl??github?.repositoryUrl??null };
    }) };
  }
}
function findEvidenceValue(evidence:readonly string[],name:string):string|undefined{const pattern=new RegExp(`(?:^|\\s)${name}\\s*[:=]\\s*([0-9a-f]{7,64})(?:\\s|$)`,`i`);for(const value of [...evidence].reverse()){const match=value.match(pattern);if(match)return match[1]}return undefined;}
function safeEvidenceSha(value:string|undefined):string|null{return value&&/^[0-9a-f]{7,64}$/i.test(value)?value:null;}
function extractRelatedPullRequests(evidence:readonly string[],repository:string|null):{number:number;url:string}[]{if(!repository)return[];const escaped=repository.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"),pattern=new RegExp(`https://github\\.com/${escaped}/pull/(\\d+)`,`gi`),found=new Map<number,string>();for(const value of evidence)for(const match of value.matchAll(pattern)){const number=Number(match[1]);if(Number.isSafeInteger(number))found.set(number,match[0])}return[...found].slice(0,20).map(([number,url])=>({number,url}));}
function matchesProductWorkItem(product:ProductManifestItem,work:PortfolioWork):boolean{if(!product.workItemMatch)return true;const haystack=`${work.title} ${work.id}`.toLocaleLowerCase();return product.workItemMatch.some(value=>haystack.includes(value.toLocaleLowerCase()));}
function deriveNextActionJa(product:ProductManifestItem,work:PortfolioWork|undefined,status:ProductState,issue:number|null,ball:ProductBall):string{
  if(!work)return product.nextAction;
  const ref=issue?`Issue #${issue}`:"対象Issue",title=`「${work.title}」`;
  if(status==="RUNNING")return `${ref}${title}の実装をCodexで継続し、完了後にtest・typecheck・buildとcandidate commitを検証する`;
  if(status==="ACCEPTANCE")return `${ref}${title}の自動検証済み成果を、Human Actionの手順で実機Acceptanceする`;
  if(status==="BLOCKED")return `${ref}${title}の失敗・阻害根拠を確認し、記録されたblockerを解消して再実行する`;
  if(work.workState==="VERIFYING")return `${ref}${title}のcandidateに対して自動テスト・typecheck・buildを完了する`;
  if(work.workState==="RETRYING")return `${ref}${title}の直近失敗根拠を反映してLCCから安全に再実行する`;
  if(work.workState==="DEFINED")return `${ref}${title}のAcceptance CriteriaをIssueと現行コードから確定し、Coding Readyへ進める`;
  return `${ref}${title}を${ball==="CODEX"?"Codex":"LCC"}で実行し、自動テストとbuildで完了条件を検証する`;
}
