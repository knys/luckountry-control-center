import { realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";

export interface WorkspaceConfig { workspaceId: string; repository: string; path: string; capabilities: string[] }
export interface WorkspaceManifest { version: 1; workspaces: WorkspaceConfig[] }
export interface CommandResult { code: number; stdout: string; stderr: string }
export type CommandRunner = (executable: string, args: string[], cwd: string, stdin?: string, environment?: NodeJS.ProcessEnv, signal?: AbortSignal) => Promise<CommandResult>;

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
export async function preflightWorkspace(workspace: WorkspaceConfig, run: CommandRunner = runCommand): Promise<{ branch: string; head: string }> {
  const info = await stat(workspace.path); if (!info.isDirectory()) throw new Error("workspace is not a directory");
  const canonical = await realpath(workspace.path); if (canonical !== workspace.path && canonical.toLowerCase() !== workspace.path.toLowerCase()) throw new Error("workspace canonical path mismatch");
  const root = await run("git", ["rev-parse", "--show-toplevel"], workspace.path); if (root.code || root.stdout.trim().toLowerCase() !== canonical.toLowerCase()) throw new Error("workspace is not the configured git root");
  const origin = await run("git", ["remote", "get-url", "origin"], workspace.path); if (origin.code || normalizeRepository(origin.stdout) !== workspace.repository.toLowerCase()) throw new Error("workspace origin mismatch");
  const dirty = await run("git", ["status", "--porcelain"], workspace.path); if (dirty.code || dirty.stdout.trim()) throw new Error("workspace is not clean");
  const branch = await run("git", ["branch", "--show-current"], workspace.path), head = await run("git", ["rev-parse", "HEAD"], workspace.path);
  if (branch.code || head.code || !head.stdout.trim()) throw new Error("workspace branch or HEAD unavailable"); return { branch: branch.stdout.trim(), head: head.stdout.trim() };
}
function normalizeRepository(value: string): string { return value.trim().replace(/^https:\/\/github\.com\//i, "").replace(/^git@github\.com:/i, "").replace(/\.git$/i, "").toLowerCase(); }
export const runCommand: CommandRunner = (executable, args, cwd, stdin, environment, signal) => new Promise((resolve, reject) => { const child = spawn(executable, args, { cwd, shell: false, windowsHide: true, env: environment }); let stdout = "", stderr = ""; child.stdout.on("data", data => stdout += String(data).slice(0, 65536)); child.stderr.on("data", data => stderr += String(data).slice(0, 65536)); child.on("error", reject); child.on("close", code => resolve({ code: code ?? -1, stdout: stdout.slice(-65536), stderr: stderr.slice(-65536) })); signal?.addEventListener("abort",()=>child.kill(),{once:true}); if (stdin !== undefined) child.stdin.end(stdin); });
