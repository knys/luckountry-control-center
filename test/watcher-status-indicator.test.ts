import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage,ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { watcherView } from "../src/public/watcher-status.js";
import { createRequestHandler } from "../src/http-app.js";

const now=Date.parse("2026-09-05T10:00:00.000Z");
const base={lastHeartbeat:"2026-09-05T09:59:50.000Z",heartbeatExpiresAt:"2026-09-05T10:01:00.000Z",lastScan:"2026-09-05T09:59:50.000Z",nextScan:"2026-09-05T10:00:50.000Z",queuedCount:2,activeCount:0,humanWaitingCount:1,currentWorkItem:null,currentActor:null,failure:null};

test("AC-01/02/04 Watcher API states map to distinct truthful visual states",()=>{
  assert.deepEqual(["WATCHING","DISPATCHING","DEGRADED","PAUSED"].map(state=>watcherView({...base,state},now).state),["WATCHING","DISPATCHING","DEGRADED","PAUSED"]);
  const watching=watcherView({...base,state:"WATCHING"},now);assert.equal(watching.tone,"healthy");assert.equal(watching.acceptsNewCommissions,true);assert.match(watching.summary,/READY/);
  for(const state of ["DEGRADED","PAUSED"] as const){const value=watcherView({...base,state},now);assert.notEqual(value.tone,"healthy");assert.equal(value.acceptsNewCommissions,false)}
});

test("AC-03 RUNNING is shown only with an actual active actor and WorkItem",()=>{
  assert.equal(watcherView({...base,state:"RUNNING",activeCount:1,currentActor:"CODEX",currentWorkItem:"commission-32"},now).state,"RUNNING");
  for(const invalid of [{activeCount:0,currentActor:"CODEX",currentWorkItem:"commission-32"},{activeCount:1,currentActor:null,currentWorkItem:"commission-32"},{activeCount:1,currentActor:"CODEX",currentWorkItem:null}])assert.equal(watcherView({...base,state:"RUNNING",...invalid},now).state,"DEGRADED");
});

test("AC-05 stale, invalid, and missing heartbeat never remain ONLINE",()=>{
  assert.equal(watcherView({...base,state:"WATCHING",heartbeatExpiresAt:"2026-09-05T09:59:59.000Z"},now).state,"OFFLINE");
  assert.equal(watcherView({...base,state:"WATCHING",lastHeartbeat:"invalid",lastScan:null,heartbeatExpiresAt:null},now).state,"OFFLINE");
  assert.equal(watcherView(null,now).state,"UNKNOWN");
});

test("AC-06 Watcher endpoint derives its response from the Watcher SSOT",async()=>{const observed=Date.now(),snapshot={...base,state:"WATCHING" as const,lastHeartbeat:new Date(observed).toISOString(),heartbeatExpiresAt:new Date(observed+60_000).toISOString()},handler=createRequestHandler({getProducts:async()=>({})}as never,[],undefined,undefined,undefined,undefined,undefined,undefined,undefined,{inbox:{} as never,token:"",status:async()=>snapshot});let code=0,body="";await handler({method:"GET",url:"/api/commission-watcher"}as IncomingMessage,{writeHead:(value:number)=>code=value,end:(value?:string)=>body=value??""}as unknown as ServerResponse);assert.equal(code,200);const response=JSON.parse(body);assert.equal(response.state,"WATCHING");assert.equal(response.sourceState,"WATCHING");assert.equal(response.queuedCount,2)});

test("AC-07 dashboard provides a prominent accessible indicator and polling failure invalidates green",async()=>{const [markup,script,styles]=await Promise.all([readFile("src/public/index.html","utf8"),readFile("src/public/app.ts","utf8"),readFile("src/public/styles.css","utf8")]);assert.match(markup,/id="watcher-indicator"/);assert.match(markup,/aria-live="polite"/);assert.match(script,/renderWatcher\(watcherView\(null\)\)/);assert.match(styles,/prefers-reduced-motion/);});
