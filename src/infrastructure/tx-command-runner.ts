import {execFile} from "node:child_process";
import type {TxCommand,TxCommandOutput,TxCommandRunner} from "../application/tx-maintenance.js";

const allowedExecutables=new Set(["/usr/bin/git","/usr/bin/npm","/usr/bin/systemctl","/usr/bin/sudo"]);

export class FixedTxCommandRunner implements TxCommandRunner{
  async run(command:TxCommand):Promise<TxCommandOutput>{
    if(!allowedExecutables.has(command.executable))throw new Error("TX executable is not allowlisted");
    if(!Number.isInteger(command.timeoutMs)||command.timeoutMs<1||command.timeoutMs>20*60_000)throw new Error("TX timeout is outside bounded policy");
    return new Promise(resolve=>execFile(command.executable,[...command.args],{cwd:command.cwd,timeout:command.timeoutMs,killSignal:"SIGKILL",maxBuffer:256_000,shell:false},(error,stdout,stderr)=>resolve({code:error&&"code"in error&&typeof error.code==="number"?error.code:error? -1:0,stdout:String(stdout),stderr:String(stderr)})));
  }
}
