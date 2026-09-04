import type { ExecutionRequest, ExecutionResult } from "../application/execution.js";
import type { CommandRunner, WorkspaceConfig } from "./workspace.js";
import { runCommand } from "./workspace.js";
import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, basename } from "node:path";

export interface CodexCommand { executable: string; prefixArgs: string[] }
export interface CodexProbe { version: string; codexReady: boolean; reason: string | null; args: string[]; command: CodexCommand }
export interface CanaryDiagnostics { codexResolution:{kind:"native"|"node-entrypoint";executable:string;entrypoint:string|null;argv:string[]};headless:{exitCode:number;stdoutTail:string;stderrTail:string;gitStatus:string} }
export interface FixtureDiagnostics { fixture:{executionStatus:ExecutionResult["status"];exitCode:number|null;summary:string;evidence:string[];finalAgentMessage:string|null;markerExists:boolean;markerContentMatch:boolean;gitStatus:string;expectedChangedFiles:string[];actualChangedFiles:string[]} }
const SAFE_CODEX_ARGS=["exec","--json","--color","never","--approve-for-me","-"];
const DIAGNOSTIC_TAIL_LIMIT=2048;
export async function probeCodex(run: CommandRunner = runCommand, cwd = process.cwd(), environment: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, resolvedCommand?: CodexCommand): Promise<CodexProbe> {
  const command = resolvedCommand ?? await resolveCodexCommand(environment, platform);
  const childEnvironment = safeEnvironment(environment);
  const version = await run(command.executable, [...command.prefixArgs, "--version"], cwd, undefined, childEnvironment);
  const help = await run(command.executable, [...command.prefixArgs, "exec", "--help"], cwd, undefined, childEnvironment);
  const text = `${help.stdout}\n${help.stderr}`;
  const supportsJson = /--json\b/.test(text), supportsColor=/--color\b/.test(text), supportsStdin = /stdin|PROMPT|\[PROMPT\]|`-`/i.test(text);
  const approveProvidesWorkspaceWrite = /--approve-for-me\b[\s\S]{0,300}(?:automatic review[\s\S]{0,100}workspace-write sandbox|workspace-write sandbox[\s\S]{0,100}automatic review)/i.test(text);
  const ready = version.code === 0 && help.code === 0 && supportsJson && supportsColor && supportsStdin && approveProvidesWorkspaceWrite;
  return { version: version.stdout.trim().slice(0, 200), codexReady: ready, reason: ready ? null : "required safe non-interactive Codex policy unavailable or unproven", args: ready ? [...SAFE_CODEX_ARGS] : [], command };
}
export function buildPrompt(request: ExecutionRequest): string {const criteria=(request.acceptanceCriteria??[]).map(value=>`- ${value}`).join("\n")||"- Read the Issue for the authoritative criteria.";const pilot=request.pilot?`\nControlled pilot outcome contract:\nWork only on the already-created candidate branch ${request.pilot.candidateBranch}.\nImplement the Issue, run its required verification, and commit the completed implementation on that candidate branch.\nA final message or clean no-op is not success: candidate HEAD must advance from the base commit.\nDo not modify ${request.pilot.baseBranch} or main.\nDo not push any branch.\nDo not merge.\nDo not close the Issue.\nDo not create a PR.\nDo not deploy or release.\nDo not use dangerous bypass flags.\n`:"\nUse normal git workflow and merge to main when all required gates pass and repository policy permits.\n";return `Luckountry Control Center execution.\nRepository: ${request.repository}\nSource work item: ${request.sourceUrl}\nExecution ID: ${request.executionId}\nTask title: ${request.summary}\nAcceptance Criteria snapshot:\n${criteria}\n\nUse authenticated GitHub access to read the referenced Issue as the SSOT, including its full body and current Acceptance Criteria.\nIf the private Issue cannot be read, do not claim success; stop safely and report that blocker in the final message.\nInspect the repository before editing.\nFollow the Issue acceptance/test/evidence requirements.\nDo not weaken acceptance criteria.\nDo not expose secrets.\nUse TDD when the Issue requires it.\nRun required tests/typecheck/build.${pilot}\nIf a required external/human action is genuinely unavoidable, stop safely and report a structured blocker.\n`; }
export function safeEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv { const result: NodeJS.ProcessEnv = { NO_COLOR: "1", TERM: "dumb" }; for (const key of ["PATH", "SystemRoot", "WINDIR", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP", "CODEX_HOME", "OPENAI_API_KEY", "GITHUB_TOKEN"]) { const value=environmentValue(source,key); if(value)result[key]=value; } return result; }
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
  const startedAt = new Date().toISOString(); if (!probe.codexReady || !sameArguments(probe.args,SAFE_CODEX_ARGS)) throw new Error("Codex safe non-interactive policy unavailable");
  if (!isValidatedCodexCommand(probe.command)) throw new Error("Codex executable policy unavailable");
  const output = await run(probe.command.executable, [...probe.command.prefixArgs, ...probe.args], workspace.path, buildPrompt(request), safeEnvironment(),signal); const finishedAt = new Date().toISOString();
  const lines = output.stdout.split(/\r?\n/).filter(Boolean).slice(-100),finalMessage=finalAgentMessage(output.stdout),valid=finalMessage!==null;
  const summary = sanitizeDiagnostic(output.code === 0 && valid ? "Codex completed with structured output" : output.stderr || "Codex final agent message was unavailable",500);
  return { executionId: request.executionId, status: output.code === 0 && valid ? "SUCCEEDED" : "FAILED", startedAt, finishedAt, exitCode: output.code, summary, evidence: lines.slice(-8).map(line => sanitizeDiagnostic(line,500)), retryable: output.code !== 0,...(finalMessage===null?{}:{finalAgentMessage:sanitizeDiagnostic(finalMessage,500)}) };
}
export function finalAgentMessage(stdout:string):string|null{let final:string|null=null;for(const line of stdout.split(/\r?\n/)){try{const event=JSON.parse(line) as {type?:unknown;item?:{type?:unknown;text?:unknown}};if(event.type==="item.completed"&&event.item?.type==="agent_message"&&typeof event.item.text==="string")final=event.item.text;}catch{}}return final;}
export function headlessSmokePassed(output:{code:number;stdout:string},gitStatus:string,expected="LCC_CODEX_HEADLESS_OK"):boolean{return output.code===0&&finalAgentMessage(output.stdout)?.trim()===expected&&!gitStatus.trim();}
export function canaryDiagnostics(probe:CodexProbe,output:{code:number;stdout:string;stderr:string},gitStatus:string):CanaryDiagnostics{const node=probe.command.prefixArgs.length===1;return{codexResolution:{kind:node?"node-entrypoint":"native",executable:safeBasename(probe.command.executable),entrypoint:node?"@openai/codex/bin/codex.js":null,argv:[...(node?["@openai/codex/bin/codex.js"]:[]),...probe.args]},headless:{exitCode:output.code,stdoutTail:sanitizeDiagnostic(output.stdout),stderrTail:sanitizeDiagnostic(output.stderr),gitStatus:sanitizeDiagnostic(gitStatus)}};}
export function fixtureCanaryAssessment(result:ExecutionResult,markerContent:string|null,gitStatus:string):{passed:boolean;diagnostics:FixtureDiagnostics}{const expectedChangedFiles=["marker.txt"],actualChangedFiles=parsePorcelainFiles(gitStatus),markerExists=markerContent!==null,markerContentMatch=markerContent?.trim()==="LCC_FIXTURE_OK",evidence=result.evidence.slice(-10).map(value=>sanitizeDiagnostic(value,500)),message=finalAgentMessage(result.evidence.join("\n"));const diagnostics:FixtureDiagnostics={fixture:{executionStatus:result.status,exitCode:result.exitCode??null,summary:sanitizeDiagnostic(result.summary,500),evidence,finalAgentMessage:message===null?null:sanitizeDiagnostic(message,500),markerExists,markerContentMatch,gitStatus:sanitizeDiagnostic(gitStatus),expectedChangedFiles,actualChangedFiles:actualChangedFiles.slice(0,20).map(value=>sanitizeDiagnostic(value,260))}};return{passed:result.status==="SUCCEEDED"&&markerExists&&markerContentMatch&&gitStatus==="?? marker.txt\0"&&sameArguments(actualChangedFiles,expectedChangedFiles),diagnostics};}
export function sanitizeDiagnostic(value:string,limit=DIAGNOSTIC_TAIL_LIMIT):string{return value.replace(/(token|secret|api[_-]?key)\s*["']?\s*[:=]\s*["']?[^\s,"'}]+/gi,"$1=[REDACTED]").replace(/\bBearer\s+\S+/gi,"Bearer [REDACTED]").replace(/\b(?:sk|gh[opusr])-[A-Za-z0-9_-]{8,}\b/g,"[REDACTED]").replace(/[A-Za-z]:\\(?:[^\s\\]+\\)+[^\s]*/g,"[LOCAL_PATH]").replace(/\/(?:home|Users|tmp|var)\/[^\s]*/g,"[LOCAL_PATH]").slice(-limit);}
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
function safeBasename(path:string):string{return path.replace(/\\/g,"/").split("/").pop()??"unknown";}
function parsePorcelainFiles(value:string):string[]{return value.split("\0").filter(Boolean).map(entry=>entry.length>=4?entry.slice(3):entry).sort();}
