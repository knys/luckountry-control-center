import type { ExecutionRequest, ExecutionResult } from "../application/execution.js";
import type { CommandRunner, WorkspaceConfig } from "./workspace.js";
import { runCommand } from "./workspace.js";
import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, basename } from "node:path";

export interface CodexCommand { executable: string; prefixArgs: string[] }
export interface CodexProbe { version: string; codexReady: boolean; reason: string | null; args: string[]; command: CodexCommand }
export async function probeCodex(run: CommandRunner = runCommand, cwd = process.cwd(), environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, resolvedCommand?: CodexCommand): Promise<CodexProbe> {
  const command = resolvedCommand ?? await resolveCodexCommand(environment, platform);
  const childEnvironment = safeEnvironment(environment);
  const version = await run(command.executable, [...command.prefixArgs, "--version"], cwd, undefined, childEnvironment);
  const help = await run(command.executable, [...command.prefixArgs, "exec", "--help"], cwd, undefined, childEnvironment);
  const text = `${help.stdout}\n${help.stderr}`;
  const supportsJson = /--json\b/.test(text), supportsStdin = /stdin|PROMPT|\[PROMPT\]|\s-\b/i.test(text), safeSandbox = /--sandbox\b/.test(text), approve = /--approve-for-me\b/.test(text);
  const ready = version.code === 0 && help.code === 0 && supportsJson && supportsStdin && safeSandbox && approve;
  return { version: version.stdout.trim().slice(0, 200), codexReady: ready, reason: ready ? null : "required safe non-interactive Codex flags unavailable", args: approve ? ["exec", "--json", "--sandbox", "workspace-write", "--approve-for-me", "-"] : [], command };
}
export function buildPrompt(request: ExecutionRequest): string { return `Luckountry Control Center execution.\nRepository: ${request.repository}\nSource work item: ${request.sourceUrl}\nExecution ID: ${request.executionId}\nTask summary: ${request.summary}\n\nRead the referenced GitHub Issue as the SSOT.\nInspect the repository before editing.\nFollow the Issue acceptance/test/evidence requirements.\nDo not weaken acceptance criteria.\nDo not expose secrets.\nUse TDD when the Issue requires it.\nRun required tests/typecheck/build.\nUse normal git workflow and merge to main when all required gates pass and repository policy permits.\nIf a required external/human action is genuinely unavoidable, stop safely and report a structured blocker.\n`; }
export function safeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv { const result: NodeJS.ProcessEnv = { NO_COLOR: "1", TERM: "dumb" }; for (const key of ["PATH", "SystemRoot", "WINDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "CODEX_HOME", "OPENAI_API_KEY", "GITHUB_TOKEN"]) { const value=environmentValue(source,key); if(value)result[key]=value; } return result; }
export async function resolveCodexCommand(environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<CodexCommand> {
  const pathValue = environmentValue(environment,"PATH"); if (!pathValue) throw new Error("Codex executable unavailable: PATH is missing");
  const names = platform === "win32" ? ["codex.exe", "codex.cmd"] : ["codex"];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) for (const name of names) {
    const candidate = join(directory, name); if (!isAbsolute(candidate)) continue;
    if (!await regularFile(candidate)) continue;
    if (platform === "win32" && name === "codex.cmd") {
      const entry = join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (!await regularFile(entry) || !isAbsolute(process.execPath) || basename(entry).toLowerCase() !== "codex.js") continue;
      return { executable: await realpath(process.execPath), prefixArgs: [await realpath(entry)] };
    }
    return { executable: await realpath(candidate), prefixArgs: [] };
  }
  throw new Error("Codex executable unavailable: no validated installation found on PATH");
}
export async function executeCodex(request: ExecutionRequest, workspace: WorkspaceConfig, probe: CodexProbe, run: CommandRunner = runCommand, signal?:AbortSignal): Promise<ExecutionResult> {
  const startedAt = new Date().toISOString(); if (!probe.codexReady || !sameArguments(probe.args,["exec","--json","--sandbox","workspace-write","--approve-for-me","-"])) throw new Error("Codex safe non-interactive policy unavailable");
  if (!isValidatedCodexCommand(probe.command)) throw new Error("Codex executable policy unavailable");
  const output = await run(probe.command.executable, [...probe.command.prefixArgs, ...probe.args], workspace.path, buildPrompt(request), safeEnvironment(),signal); const finishedAt = new Date().toISOString();
  const lines = output.stdout.split(/\r?\n/).filter(Boolean).slice(-100); let valid = false; for (const line of lines) { try { const event = JSON.parse(line) as { type?: string }; if (event.type) valid = true; } catch {} }
  const summary = redact((output.code === 0 && valid ? "Codex completed with structured output" : output.stderr || "Codex output was not structured").slice(0, 500));
  return { executionId: request.executionId, status: output.code === 0 && valid ? "SUCCEEDED" : "FAILED", startedAt, finishedAt, exitCode: output.code, summary, evidence: lines.slice(-10).map(line => redact(line.slice(0, 500))), retryable: output.code !== 0 };
}
function redact(value: string): string { return value.replace(/(token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]"); }
function sameArguments(actual:readonly string[],expected:readonly string[]):boolean{return actual.length===expected.length&&actual.every((value,index)=>value===expected[index]);}
function isValidatedCodexCommand(command: CodexCommand): boolean {
  if (!isAbsolute(command.executable)) return false;
  if (command.prefixArgs.length===0) return /^codex(?:\.exe)?$/i.test(basename(command.executable));
  if (command.prefixArgs.length!==1 || !isAbsolute(command.prefixArgs[0]!)) return false;
  const normalized=command.prefixArgs[0]!.replace(/\\/g,"/").toLowerCase();
  return /^node(?:\.exe)?$/i.test(basename(command.executable)) && normalized.endsWith("/node_modules/@openai/codex/bin/codex.js");
}
async function regularFile(path: string): Promise<boolean> { try { return (await stat(path)).isFile(); } catch { return false; } }
function environmentValue(environment:NodeJS.ProcessEnv,name:string):string|undefined{const key=Object.keys(environment).find(item=>item.toLowerCase()===name.toLowerCase());return key?environment[key]:undefined;}
