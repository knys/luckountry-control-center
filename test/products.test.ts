import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequestHandler } from "../src/http-app.js";
import { parseGitHubMetadata, parseProductsManifest, ProductService, type GitHubMetadata, type GitHubMetadataProvider } from "../src/products.js";

const item = { id: "product-one", name: "Product One", repository: "knys/repo", summary: "Review required", status: "UNKNOWN", ball: "UNKNOWN", nextAction: "Review manifest" } as const;
const manifest = parseProductsManifest({ version: 1, products: [item] });
const metadata: GitHubMetadata = { repository: "knys/repo", repositoryUrl: "https://github.com/knys/repo", defaultBranch: "main", headSha: "abcdef123456", openIssues: 2, openPullRequests: 1, updatedAt: "2026-09-02T00:00:00Z" };

test("parses the checked-in products manifest", async () => {
  const parsed = parseProductsManifest(JSON.parse(await readFile("config/products.json", "utf8")));
  assert.equal(parsed.products.length, 11);
  assert.equal(parsed.products.filter((product) => product.repository === "knys/TOBIE").length, 5);
});

test("routes active work only to the matching product in a shared repository",async()=>{
  const shared=parseProductsManifest({version:1,products:[
    {...item,id:"draw",name:"DRAW",workItemMatch:["DRAW"]},
    {...item,id:"keiba",name:"KEIBA",workItemMatch:["KEIBA"]},
  ]});
  const work={id:"github:knys/repo:174",source:{repository:"knys/repo",externalId:"174"},title:"KEIBA Operations",sourceUrl:"https://github.com/knys/repo/issues/174",workState:"RUNNING",ballHolder:"CODEX",nextAction:{summary:"Continue execution"},blocker:null,evidence:[]};
  const execution={executionId:"run-174",workItemId:work.id,resultStatus:"ACTIVE",startedAt:"2026-09-04T00:00:00Z",finishedAt:null,summary:"Running"};
  const service=new ProductService(shared,{fetch:async()=>new Map([[metadata.repository,metadata]])},60_000,()=>100_000,async()=>({workItems:[work],executions:[execution]}));
  const result=await service.getProducts();
  assert.equal(result.products.find(value=>value.id==="keiba")?.status,"RUNNING");
  assert.equal(result.products.find(value=>value.id==="keiba")?.activeActor,"CODEX");
  assert.equal(result.products.find(value=>value.id==="keiba")?.issueNumber,174);
  assert.equal(result.products.find(value=>value.id==="keiba")?.issueUrl,work.sourceUrl);
  assert.match(result.products.find(value=>value.id==="keiba")?.nextActionJa??"",/Issue #174/);
  assert.equal(result.products.find(value=>value.id==="draw")?.status,"UNKNOWN");
  assert.equal(result.products.find(value=>value.id==="draw")?.activeActor,null);
});

test("projects DEFINED work as an actionable LCC queue instead of a Human gate",async()=>{
  const work={id:"github:knys/repo:7",source:{repository:"knys/repo",externalId:"7"},title:"地図表示を修正する",sourceUrl:"https://github.com/knys/repo/issues/7",workState:"DEFINED",ballHolder:"HUMAN",nextAction:{summary:"Complete the definition and Coding Ready Gate"},blocker:null,evidence:[]};
  const service=new ProductService(manifest,{fetch:async()=>new Map()},60_000,()=>100_000,async()=>({workItems:[work],executions:[]}));
  const product=(await service.getProducts()).products[0]!;
  assert.equal(product.status,"QUEUED");
  assert.equal(product.ball,"LCC");
  assert.equal(product.queuedActor,"LCC");
  assert.equal(product.humanActionJa,null);
  assert.match(product.nextActionJa,/Issue #7.*Acceptance Criteria.*Coding Ready/);
});

test("preserves an explicit physical Human acceptance with a concrete action and reason",async()=>{
  const human=parseProductsManifest({version:1,products:[{...item,primaryIssue:8,status:"ACCEPTANCE",ball:"HUMAN",humanActionJa:"iPhoneのStandalone版で保存後に再起動し、データが残ることを確認してPASS/FAILを判断する",humanGate:"iPhone実機操作と目視によるUX判定が必要"}]});
  const work={id:"github:knys/repo:8",source:{repository:"knys/repo",externalId:"8"},title:"PWA実機Acceptance",sourceUrl:"https://github.com/knys/repo/issues/8",workState:"DEFINED",ballHolder:"HUMAN",nextAction:{summary:"generic"},blocker:null,evidence:[]};
  const product=(await new ProductService(human,{fetch:async()=>new Map()},60_000,()=>100_000,async()=>({workItems:[work],executions:[]})).getProducts()).products[0]!;
  assert.equal(product.ball,"HUMAN");
  assert.equal(product.issueNumber,8);
  assert.match(product.humanActionJa??"",/iPhone.*PASS\/FAIL/);
  assert.match(product.humanGate??"",/実機/);
});

test("never reports RUNNING without a matching active execution",async()=>{
  const running={...item,status:"RUNNING" as const,ball:"CODEX" as const};
  const product=(await new ProductService(parseProductsManifest({version:1,products:[running]}),{fetch:async()=>new Map()}).getProducts()).products[0]!;
  assert.equal(product.status,"READY");
  assert.equal(product.activeActor,null);
  assert.equal(product.currentRun,null);
});

test("validates product status and ball", () => {
  assert.throws(() => parseProductsManifest({ version: 1, products: [{ ...item, status: "BROKEN" }] }), /status/);
  assert.throws(() => parseProductsManifest({ version: 1, products: [{ ...item, ball: "ROBOT" }] }), /ball/);
  assert.throws(() => parseProductsManifest({ version: 1, products: [item, item] }), /duplicate/);
});

test("parses GitHub GraphQL repository metadata", () => {
  const result = parseGitHubMetadata({ data: { r0: { url: metadata.repositoryUrl, updatedAt: metadata.updatedAt, defaultBranchRef: { name: "main", target: { oid: metadata.headSha } }, issues: { totalCount: 2 }, pullRequests: { totalCount: 1 } } } }, new Map([["r0", "knys/repo"]]));
  assert.deepEqual(result.get("knys/repo"), metadata);
});

test("uses cached metadata and marks it stale after GitHub failure", async () => {
  let currentTime = 1_000;
  let fail = false;
  const provider: GitHubMetadataProvider = { fetch: async () => { if (fail) throw new Error("offline"); return new Map([[metadata.repository, metadata]]); } };
  const service = new ProductService(manifest, provider, 60, () => currentTime);
  const fresh = await service.getProducts();
  assert.equal(fresh.stale, false);
  assert.equal(fresh.products[0]?.headSha, metadata.headSha);
  fail = true;
  currentTime += 61;
  const fallback = await service.getProducts();
  assert.equal(fallback.stale, true);
  assert.equal(fallback.products[0]?.headSha, metadata.headSha);
  assert.match(fallback.warning ?? "", /cached/);
});

test("serves /api/products and stays healthy when GitHub is unavailable", async () => {
  const provider: GitHubMetadataProvider = { fetch: async () => { throw new Error("GitHub unavailable"); } };
  const service = new ProductService(manifest, provider, 60_000, () => 100_000);
  const handler = createRequestHandler(service, []);
  const request = async (url: string) => {
    let status = 0;
    let body = "";
    await new Promise<void>((resolve) => {
      const response = { writeHead: (value: number) => { status = value; }, end: (value: string) => { body = value; resolve(); } } as unknown as ServerResponse;
      void handler({ method: "GET", url } as IncomingMessage, response);
    });
    return { status, body: JSON.parse(body) as Record<string, unknown> };
  };
  const productsResponse = await request("/api/products");
  assert.equal(productsResponse.status, 200);
  const body = productsResponse.body as unknown as { stale: boolean; products: unknown[] };
  assert.equal(body.stale, true);
  assert.equal(body.products.length, 1);
  const healthResponse = await request("/health");
  assert.equal(healthResponse.status, 200);
  assert.equal(healthResponse.body.version, "0.3.0");
});
