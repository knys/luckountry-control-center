import type { ExecutionRequest, ExecutionResult } from "../application/execution.js";
import type { CommandRunner, WorkspaceConfig } from "./workspace.js";
import { runCommand } from "./workspace.js";

export interface CodexProbe { version: string; codexReady: boolean; reason: string | null; args: string[] }
export async function probeCodex(run: CommandRunner = runCommand, cwd = process.cwd()): Promise<CodexProbe> {
  const version = await run("codex", ["--version"], cwd, undefined, safeEnvironment());
  const help = await run("codex", ["exec", "--help"], cwd, undefined, safeEnvironment());
  const text = `${help.stdout}\n${help.stderr}`;
  const supportsJson = /--json\b/.test(text), supportsStdin = /stdin|PROMPT|\[PROMPT\]|\s-\b/i.test(text), safeSandbox = /--sandbox\b/.test(text), approve = /--approve-for-me\b/.test(text);
  const ready = version.code === 0 && help.code === 0 && supportsJson && supportsStdin && safeSandbox && approve;
  return { version: version.stdout.trim().slice(0, 200), codexReady: ready, reason: ready ? null : "required safe non-interactive Codex flags unavailable", args: approve ? ["exec", "--json", "--sandbox", "workspace-write", "--approve-for-me", "-"] : [] };
}
export function buildPrompt(request: ExecutionRequest): string { return `Luckountry Control Center execution.\nRepository: ${request.repository}\nSource work item: ${request.sourceUrl}\nExecution ID: ${request.executionId}\nTask summary: ${request.summary}\n\nRead the referenced GitHub Issue as the SSOT.\nInspect the repository before editing.\nFollow the Issue acceptance/test/evidence requirements.\nDo not weaken acceptance criteria.\nDo not expose secrets.\nUse TDD when the Issue requires it.\nRun required tests/typecheck/build.\nUse normal git workflow and merge to main when all required gates pass and repository policy permits.\nIf a required external/human action is genuinely unavoidable, stop safely and report a structured blocker.\n`; }
export function safeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv { const result: NodeJS.ProcessEnv = { NO_COLOR: "1", TERM: "dumb" }; for (const key of ["PATH", "SystemRoot", "WINDIR", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "CODEX_HOME", "OPENAI_API_KEY", "GITHUB_TOKEN"]) if (source[key]) result[key] = source[key]; return result; }
export async function executeCodex(request: ExecutionRequest, workspace: WorkspaceConfig, probe: CodexProbe, run: CommandRunner = runCommand, signal?:AbortSignal): Promise<ExecutionResult> {
  const startedAt = new Date().toISOString(); if (!probe.codexReady || !sameArguments(probe.args,["exec","--json","--sandbox","workspace-write","--approve-for-me","-"])) throw new Error("Codex safe non-interactive policy unavailable");
  const output = await run("codex", probe.args, workspace.path, buildPrompt(request), safeEnvironment(),signal); const finishedAt = new Date().toISOString();
  const lines = output.stdout.split(/\r?\n/).filter(Boolean).slice(-100); let valid = false; for (const line of lines) { try { const event = JSON.parse(line) as { type?: string }; if (event.type) valid = true; } catch {} }
  const summary = redact((output.code === 0 && valid ? "Codex completed with structured output" : output.stderr || "Codex output was not structured").slice(0, 500));
  return { executionId: request.executionId, status: output.code === 0 && valid ? "SUCCEEDED" : "FAILED", startedAt, finishedAt, exitCode: output.code, summary, evidence: lines.slice(-10).map(line => redact(line.slice(0, 500))), retryable: output.code !== 0 };
}
function redact(value: string): string { return value.replace(/(token|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[REDACTED]"); }
function sameArguments(actual:readonly string[],expected:readonly string[]):boolean{return actual.length===expected.length&&actual.every((value,index)=>value===expected[index]);}
