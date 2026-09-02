import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectSystemStatus } from "./system.js";

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? "3000");
const publicDir = join(dirname(fileURLToPath(import.meta.url)), "public");
const assets = new Map<string, readonly [string, string]>([["/", ["index.html", "text/html; charset=utf-8"]], ["/styles.css", ["styles.css", "text/css; charset=utf-8"]], ["/app.js", ["app.js", "text/javascript; charset=utf-8"]]]);

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  try {
    if (request.method !== "GET") return json(response, 405, { error: "method_not_allowed" });
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === "/health") return json(response, 200, { status: "ok", service: "luckountry-control-center", version: "0.1.0" });
    if (path === "/api/system-status") return json(response, 200, await collectSystemStatus());
    const asset = assets.get(path);
    if (!asset) return json(response, 404, { error: "not_found" });
    const [file, contentType] = asset;
    const body = await readFile(join(publicDir, file));
    response.writeHead(200, { "content-type": contentType, "cache-control": file === "index.html" ? "no-cache" : "public, max-age=3600", "x-content-type-options": "nosniff" });
    response.end(body);
  } catch (error) {
    console.error(error);
    json(response, 500, { error: "internal_error" });
  }
});

server.listen(port, host, () => console.log(`Luckountry Control Center listening on http://${host}:${port}`));

function shutdown(): void { server.close(() => process.exit(0)); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
