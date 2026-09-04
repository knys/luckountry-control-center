import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

async function remove(...names) {
  await Promise.all(names.map((name) => rm(join(root, name), { recursive: true, force: true })));
}

async function runNode(...args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`command failed with ${signal ?? `exit ${code}`}`)));
  });
}

async function copyAssets() {
  const files = [
    ["src/public/index.html", "dist/public/index.html"],
    ["src/public/styles.css", "dist/public/styles.css"],
    ["src/v2/public/index.html", "dist/v2/public/index.html"],
    ["src/v2/public/styles.css", "dist/v2/public/styles.css"],
    ["config/products.json", "dist/config/products.json"]
  ];
  for (const [source, destination] of files) {
    await mkdir(dirname(join(root, destination)), { recursive: true });
    await copyFile(join(root, source), join(root, destination));
  }
}

async function testFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await testFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".test.js")) files.push(path);
  }
  return files.sort();
}

async function buildTest() {
  await remove(".test-dist");
  await runNode(tsc, "-p", "tsconfig.test.json");
}

const task = process.argv[2];
if (task === "clean") await remove("dist", ".test-dist");
else if (task === "build") { await remove("dist", ".test-dist"); await runNode(tsc, "-p", "tsconfig.json"); await copyAssets(); }
else if (task === "build-test") await buildTest();
else if (task === "test") { await buildTest(); const files = await testFiles(join(root, ".test-dist", "test")); if (!files.length) throw new Error("no test files found"); await runNode("--test", ...files); }
else if (task === "typecheck") { await runNode(tsc, "-p", "tsconfig.json", "--noEmit"); await runNode(tsc, "-p", "tsconfig.test.json", "--noEmit"); }
else throw new Error(`unknown task: ${task ?? ""}`);
