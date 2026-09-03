import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canaryDiagnostics, executeCodex, fixtureCanaryAssessment, headlessSmokePassed, probeCodex, safeEnvironment } from "./codex-cli.js";
import { runCommand } from "./workspace.js";

const directory=await mkdtemp(join(tmpdir(),"lcc-codex-canary-"));
try{
  await runCommand("git",["init"],directory);await runCommand("git",["config","user.email","canary@localhost"],directory);await runCommand("git",["config","user.name","LCC Canary"],directory);await writeFile(join(directory,"README.md"),"fixture\n");await runCommand("git",["add","README.md"],directory);await runCommand("git",["commit","-m","fixture"],directory);
  const probe=await probeCodex(runCommand,directory);if(!probe.codexReady)throw new Error(probe.reason??"Codex unavailable");
  const smoke=await runCommand(probe.command.executable,[...probe.command.prefixArgs,...probe.args],directory,"Return exactly LCC_CODEX_HEADLESS_OK and make no file changes.",safeEnvironment());const afterSmoke=await runCommand("git",["status","--porcelain"],directory);if(!headlessSmokePassed(smoke,afterSmoke.stdout)){console.error(JSON.stringify(canaryDiagnostics(probe,smoke,afterSmoke.stdout),null,2));throw new Error("headless smoke failed");}
  const result=await executeCodex({executionId:"lcc-canary",workItemId:"canary",repository:"fixture/lcc-canary",workspaceId:"lcc-canary",actionKind:"EXECUTE",summary:"Create marker.txt containing exactly LCC_FIXTURE_OK and do not modify any other file.",requiredCapabilities:["CODE_EDIT"],sourceUrl:"https://github.com/fixture/lcc-canary/issues/1"},{workspaceId:"lcc-canary",repository:"fixture/lcc-canary",path:directory,capabilities:["CODE_EDIT"]},probe);
  const status=await runCommand("git",["status","--porcelain=v1","-z"],directory);const marker=await readFile(join(directory,"marker.txt"),"utf8").catch(()=>null);const assessment=fixtureCanaryAssessment(result,marker,status.stdout);if(!assessment.passed){console.error(JSON.stringify(assessment.diagnostics,null,2));throw new Error("fixture workspace-write canary failed");}
  console.log(JSON.stringify({codexVersion:probe.version,headlessSmoke:"PASS",fixtureCanary:"PASS",changedFiles:["marker.txt"]}));
}finally{await rm(directory,{recursive:true,force:true});}
