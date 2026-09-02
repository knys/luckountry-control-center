import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeviceProviders } from "./devices.js";
import { GhCliMetadataProvider, parseProductsManifest, ProductService } from "./products.js";
import { createRequestHandler } from "./http-app.js";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? "3000");
const manifestPath = process.env.PRODUCTS_MANIFEST ?? join(dirname(fileURLToPath(import.meta.url)), "config", "products.json");
const deviceProviders = createDeviceProviders();
const productService = new ProductService(parseProductsManifest(JSON.parse(await readFile(manifestPath, "utf8"))), new GhCliMetadataProvider());
const server = createServer(createRequestHandler(productService, deviceProviders));

server.listen(port, host, () => console.log(`Luckountry Control Center listening on http://${host}:${port}`));

function shutdown(): void { server.close(() => process.exit(0)); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
