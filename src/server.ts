import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeviceProviders } from "./devices.js";
import { GhCliMetadataProvider, parseProductsManifest, ProductService } from "./products.js";
import { createRequestHandler } from "./http-app.js";
import { composeIssueRuntime } from "./composition.js";
import { discoverRepositories } from "./composition.js";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? "3000");
const manifestPath = process.env.PRODUCTS_MANIFEST ?? join(dirname(fileURLToPath(import.meta.url)), "config", "products.json");
const deviceProviders = createDeviceProviders();
const manifest = parseProductsManifest(JSON.parse(await readFile(manifestPath, "utf8")));
const productService = new ProductService(manifest, new GhCliMetadataProvider());
const issueRuntime = await composeIssueRuntime(manifest);
const repositories = discoverRepositories(manifest);
const server = createServer(createRequestHandler(productService, deviceProviders, undefined, () => issueRuntime.runtime.status(), async () => (await Promise.all(repositories.map((repository) => issueRuntime.repository.list(repository)))).flat()));

server.listen(port, host, () => console.log(`Luckountry Control Center listening on http://${host}:${port}`));
issueRuntime.runtime.start();

let shutdownStarted = false;
async function shutdown(): Promise<void> {
  if (shutdownStarted) return;
  shutdownStarted = true;
  await issueRuntime.runtime.stop();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
function handleSignal(): void {
  void shutdown().then(() => process.exit(0), (error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : "shutdown failed");
    process.exit(1);
  });
}
process.on("SIGTERM", handleSignal);
process.on("SIGINT", handleSignal);
