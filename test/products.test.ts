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
  assert.equal(parsed.products.length, 10);
  assert.equal(parsed.products.filter((product) => product.repository === "knys/TOBIE").length, 4);
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
