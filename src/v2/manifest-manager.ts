import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { promises } from "node:fs";
import { basename, dirname } from "node:path";

export interface V2Product{id:string;name:string;repository:string;workItemMatch?:string[];worker?:string}
export interface ManifestReloadEvent{event:"MANIFEST_RELOAD_STARTED"|"MANIFEST_RELOAD_SUCCEEDED"|"MANIFEST_RELOAD_FAILED";at:string;addedRepositories?:string[];removedRepositories?:string[];error?:string}
export interface ManifestReloadStatus{manifestReloadEnabled:boolean;manifestVersion:string;repositoryCount:number;lastManifestReloadAt:string;lastManifestReloadResult:"SUCCEEDED"|"FAILED";lastManifestReloadError:string|null;currentManifestSource:string;addedRepositories:string[];removedRepositories:string[]}
interface Options{debounceMs?:number;log?:(event:ManifestReloadEvent)=>void;clock?:()=>Date}

export class ManifestManager{
  private current:V2Product[];private snapshot:ManifestReloadStatus;private watcher:FSWatcher|null=null;private timer:NodeJS.Timeout|null=null;private pending:Promise<unknown>=Promise.resolve();
  private constructor(private path:string,products:V2Product[],private options:Options){const at=this.now(),repositories=unique(products);this.current=products;this.snapshot={manifestReloadEnabled:true,manifestVersion:version(products),repositoryCount:repositories.length,lastManifestReloadAt:at,lastManifestReloadResult:"SUCCEEDED",lastManifestReloadError:null,currentManifestSource:`config/${basename(path)}`,addedRepositories:repositories,removedRepositories:[]}}
  static async open(path:string,options:Options={}){const products=parseManifest(await promises.readFile(path,"utf8"));return new ManifestManager(path,products,options)}
  products(){return structuredClone(this.current)}
  repositories(){return unique(this.current)}
  status(){return structuredClone(this.snapshot)}
  start(){if(this.watcher)return;this.watcher=watch(dirname(this.path),(_event,file)=>{if(file&&String(file)!==basename(this.path))return;if(this.timer)clearTimeout(this.timer);this.timer=setTimeout(()=>void this.reload(),this.options.debounceMs??150)});this.watcher.on("error",()=>void this.recordFailure("manifest watch failed"))}
  stop(){if(this.timer)clearTimeout(this.timer);this.timer=null;this.watcher?.close();this.watcher=null}
  reload(){const operation=this.pending.then(()=>this.reloadOnce(),()=>this.reloadOnce());this.pending=operation;return operation}
  private async reloadOnce(){const at=this.now();this.emit({event:"MANIFEST_RELOAD_STARTED",at});try{const next=parseManifest(await promises.readFile(this.path,"utf8")),before=this.repositories(),after=unique(next),added=after.filter(v=>!before.includes(v)),removed=before.filter(v=>!after.includes(v));this.current=next;this.snapshot={...this.snapshot,manifestVersion:version(next),repositoryCount:after.length,lastManifestReloadAt:at,lastManifestReloadResult:"SUCCEEDED",lastManifestReloadError:null,addedRepositories:added,removedRepositories:removed};this.emit({event:"MANIFEST_RELOAD_SUCCEEDED",at,addedRepositories:added,removedRepositories:removed});return this.status()}catch{return this.recordFailure("manifest read or validation failed",at)}}
  private recordFailure(error:string,at=this.now()){this.snapshot={...this.snapshot,lastManifestReloadAt:at,lastManifestReloadResult:"FAILED",lastManifestReloadError:error,addedRepositories:[],removedRepositories:[]};this.emit({event:"MANIFEST_RELOAD_FAILED",at,error});return this.status()}
  private now(){return(this.options.clock?.()??new Date()).toISOString()}
  private emit(event:ManifestReloadEvent){(this.options.log??defaultLog)(event)}
}

export function parseManifest(text:string):V2Product[]{const raw=JSON.parse(text);if(raw?.version!==1||!Array.isArray(raw.products)||!raw.products.length)throw Error("invalid product manifest");const ids=new Set<string>(),products:V2Product[]=[];for(const value of raw.products){if(!value||typeof value!=="object")throw Error("invalid product");const p=value as Record<string,unknown>,id=String(p.id??""),name=String(p.name??"");if(!id||!name||ids.has(id))throw Error("invalid product identity");ids.add(id);if(p.repository==null)continue;const repository=String(p.repository);if(!/^knys\/[\w.-]+$/.test(repository))throw Error("invalid repository");const product:V2Product={id,name,repository,worker:workerFor(p)};if(Array.isArray(p.workItemMatch))product.workItemMatch=p.workItemMatch.map(String);products.push(product)}if(!products.length)throw Error("manifest contains no repositories");return products}
function workerFor(product:Record<string,unknown>){const text=`${product.name??""} ${product.summary??""}`;return /UE5|Windows|GTX1060|1060PC/i.test(text)?"GTX1060":"TX66KWH"}
function unique(products:V2Product[]){return[...new Set(products.map(p=>p.repository))]}
function version(products:V2Product[]){return createHash("sha256").update(JSON.stringify(products)).digest("hex").slice(0,16)}
function defaultLog(event:ManifestReloadEvent){console.log(JSON.stringify(event))}
