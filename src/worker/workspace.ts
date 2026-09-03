import { lstat, realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";

export interface WorkspaceConfig { workspaceId: string; repository: string; path: string; capabilities: string[] }
export interface WorkspaceManifest { version: 1; workspaces: WorkspaceConfig[] }
export interface CommandResult { code: number; stdout: string; stderr: string }
export type CommandRunner = (executable: string, args: string[], cwd: string, stdin?: string, environment?: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<CommandResult>;
interface FileIdentity { dev: number | bigint; ino: number | bigint; isDirectory(): boolean }
export interface WorkspaceFileSystem { realpath(path: string): Promise<string>; stat(path: string): Promise<FileIdentity>; lstat(path: string): Promise<FileIdentity & { isSymbolicLink(): boolean }> }
const workspaceFileSystem: WorkspaceFileSystem = { realpath, stat, lstat };

export function parseWorkspaceManifest(value: unknown): WorkspaceManifest {
  const root = value as Partial<WorkspaceManifest>;
  if (root?.version !== 1 || !Array.isArray(root.workspaces)) throw new Error("invalid workspace manifest");
  const ids = new Set<string>(), repositories = new Set<string>();
  for (const item of root.workspaces) {
    if (!item || !item.workspaceId || !item.repository || !item.path || !Array.isArray(item.capabilities) || ids.has(item.workspaceId) || repositories.has(item.repository)) throw new Error("workspace allowlist must be one-to-one");
    if (!/^[A-Za-z0-9._-]+$/.test(item.workspaceId)) throw new Error("invalid workspaceId"); ids.add(item.workspaceId); repositories.add(item.repository);
  }
  return structuredClone(root as WorkspaceManifest);
}
export function resolveWorkspace(manifest: WorkspaceManifest, workspaceId: string, repository: string): WorkspaceConfig {
  const matches = manifest.workspaces.filter((item) => item.workspaceId === workspaceId && item.repository === repository);
  if (matches.length !== 1) throw new Error("workspace is not allowlisted for repository"); return structuredClone(matches[0]!);
}
export async function preflightWorkspace(workspace: WorkspaceConfig, run: CommandRunner = runCommand, fileSystem: WorkspaceFileSystem = workspaceFileSystem): Promise<{ branch: string; head: string }> {
  await assertNoLinksInPath(workspace.path,fileSystem);
  const configured = await fileSystem.stat(workspace.path); if (!configured.isDirectory()) throw new Error("workspace is not a directory");
  const canonical = await fileSystem.realpath(workspace.path);
  const canonicalInfo = await fileSystem.stat(canonical); if (!sameFileIdentity(configured, canonicalInfo)) throw new Error("workspace canonical identity mismatch");
  const root = await run("git", ["rev-parse", "--show-toplevel"], canonical); if (root.code) throw new Error("workspace is not the configured git root");
  let rootCanonical: string; try { rootCanonical = await fileSystem.realpath(root.stdout.trim()); } catch { throw new Error("workspace is not the configured git root"); }
  const rootInfo = await fileSystem.stat(rootCanonical); if (!sameFileIdentity(canonicalInfo, rootInfo)) throw new Error("workspace is not the configured git root");
  const origin = await run("git", ["remote", "get-url", "origin"], workspace.path); if (origin.code || normalizeRepository(origin.stdout) !== workspace.repository.toLowerCase()) throw new Error("workspace origin mismatch");
  const dirty = await run("git", ["status", "--porcelain"], workspace.path); if (dirty.code || dirty.stdout.trim()) throw new Error("workspace is not clean");
  const branch = await run("git", ["branch", "--show-current"], workspace.path), head = await run("git", ["rev-parse", "HEAD"], workspace.path);
  if (branch.code || head.code || !head.stdout.trim()) throw new Error("workspace branch or HEAD unavailable"); return { branch: branch.stdout.trim(), head: head.stdout.trim() };
}
export function sameFileIdentity(left: Pick<FileIdentity,"dev"|"ino">, right: Pick<FileIdentity,"dev"|"ino">): boolean { return left.dev === right.dev && left.ino === right.ino; }
async function assertNoLinksInPath(path:string,fileSystem:WorkspaceFileSystem):Promise<void>{let current=resolve(path);for(;;){const info=await fileSystem.lstat(current);if(info.isSymbolicLink())throw new Error("workspace path must not traverse a symlink or junction");const parent=dirname(current);if(parent===current)break;current=parent;}}
function normalizeRepository(value: string): string { return value.trim().replace(/^https:\/\/github\.com\//i, "").replace(/^git@github\.com:/i, "").replace(/\.git$/i, "").toLowerCase(); }
export const runCommand: CommandRunner = (executable, args, cwd, stdin, environment, signal) => new Promise((resolve, reject) => { const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, env: environment }); let stdout = "", stderr = ""; child.stdout.on("data", data => stdout += String(data).slice(0, 65536)); child.stderr.on("data", data => stderr += String(data).slice(0, 65536)); child.on("error", reject); child.on("close", code => resolve({ code: code ?? -1, stdout: stdout.slice(-65536), stderr: stderr.slice(-65536) })); signal?.addEventListener("abort",()=>child.kill(),{once:true}); if (stdin !== undefined) child.stdin.end(stdin); });
