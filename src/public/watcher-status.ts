export const watcherStates=["WATCHING","DISPATCHING","RUNNING","DEGRADED","PAUSED","OFFLINE","UNKNOWN"] as const;
export type WatcherState=typeof watcherStates[number];
export interface WatcherSnapshot{state?:unknown;lastHeartbeat?:unknown;lastScan?:unknown;heartbeatExpiresAt?:unknown;nextScan?:unknown;queuedCount?:unknown;activeCount?:unknown;humanWaitingCount?:unknown;currentWorkItem?:unknown;currentActor?:unknown;failure?:unknown}
export interface WatcherView{state:WatcherState;sourceState:string|null;label:string;summary:string;tone:"healthy"|"active"|"warning"|"offline";acceptsNewCommissions:boolean;stale:boolean;lastHeartbeat:string|null;nextScan:string|null;queuedCount:number;activeCount:number;humanWaitingCount:number;currentWorkItem:string|null;currentActor:string|null;degradedReason:string|null}
const text=(value:unknown,maximum=500)=>typeof value==="string"&&value.length>0?value.slice(0,maximum):null;
const count=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)?Math.max(0,Math.floor(value)):0;
const validDate=(value:string|null)=>value!==null&&Number.isFinite(Date.parse(value));
/** Map the Watcher SSOT to the only state model consumed by the dashboard. */
export function watcherView(snapshot:WatcherSnapshot|null,now=Date.now(),legacyStaleAfterMs=150_000):WatcherView{
  const sourceState=text(snapshot?.state,32),lastHeartbeat=text(snapshot?.lastHeartbeat)??text(snapshot?.lastScan),expiresAt=text(snapshot?.heartbeatExpiresAt);
  const stale=!snapshot||!validDate(lastHeartbeat)||(validDate(expiresAt)?now>Date.parse(expiresAt!):now-Date.parse(lastHeartbeat!)>legacyStaleAfterMs);
  const queuedCount=count(snapshot?.queuedCount),activeCount=count(snapshot?.activeCount),humanWaitingCount=count(snapshot?.humanWaitingCount),currentActor=text(snapshot?.currentActor,120),currentWorkItem=text(snapshot?.currentWorkItem,200);
  let state:WatcherState=watcherStates.includes(sourceState as WatcherState)?sourceState as WatcherState:"UNKNOWN";
  if(stale)state=snapshot?"OFFLINE":"UNKNOWN";else if(state==="RUNNING"&&(activeCount<1||!currentActor||!currentWorkItem))state="DEGRADED";
  const presentation:Record<WatcherState,{label:string;summary:string;tone:WatcherView["tone"];accepts:boolean}>={WATCHING:{label:"WATCHING",summary:"ONLINE · READY FOR COMMISSION",tone:"healthy",accepts:true},DISPATCHING:{label:"DISPATCHING",summary:"ONLINE · STARTING ACTOR",tone:"active",accepts:true},RUNNING:{label:"RUNNING",summary:"ONLINE · ACTOR WORKING",tone:"active",accepts:true},DEGRADED:{label:"DEGRADED",summary:"RETRYING · ATTENTION",tone:"warning",accepts:false},PAUSED:{label:"PAUSED",summary:"DISPATCH PAUSED",tone:"warning",accepts:false},OFFLINE:{label:"OFFLINE",summary:"HEARTBEAT LOST",tone:"offline",accepts:false},UNKNOWN:{label:"UNKNOWN",summary:"STATUS UNAVAILABLE",tone:"offline",accepts:false}};
  const value=presentation[state];return{state,sourceState,label:value.label,summary:value.summary,tone:value.tone,acceptsNewCommissions:value.accepts,stale,lastHeartbeat:validDate(lastHeartbeat)?lastHeartbeat:null,nextScan:text(snapshot?.nextScan),queuedCount,activeCount,humanWaitingCount,currentWorkItem,currentActor,degradedReason:text(snapshot?.failure)};
}
