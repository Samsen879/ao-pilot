import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const OWNER_AUTHORITY_SCHEMA = 'ao.owner-authority-event.v1';
const EFFECTS = new Set(['execution.run','execution.rerun','conversation.restore']);
const SCOPE_KEYS=['repository','project_id','task_id','pr_number','worker_ref','session_id','generation','head_sha','tree_sha','input_digest','prior_invocation_id'];
function hold(message) { throw new Error(`${message}; HOLD`); }
function exact(value, keys, label) {
 if(!value || Object.getPrototypeOf(value)!==Object.prototype || Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))hold(`Invalid ${label} fields`);
 return value;
}
function text(value,label) { if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>4096)hold(`Invalid ${label}`);return value; }
function id(value,label){text(value,label);if(!/^[a-zA-Z0-9_-]{1,128}$/.test(value))hold(`Invalid ${label}`);return value;}
function hash(value,size,label){if(typeof value!=='string'||!new RegExp(`^[a-f0-9]{${size}}$`).test(value))hold(`Invalid ${label}`);return value;}
export function canonicalAuthorityJson(value) {
 if(value===null || typeof value==='boolean' || typeof value==='string')return JSON.stringify(value);
 if(typeof value==='number' && Number.isSafeInteger(value))return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonicalAuthorityJson).join(',')+']';
 if(value&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalAuthorityJson(value[k])).join(',')+'}';
 hold('Noncanonical authority value');
}
export function authorityDigest(value){return crypto.createHash('sha256').update(canonicalAuthorityJson(value)).digest('hex');}
export function normalizeOwnerScope(scope) {
 exact(scope,SCOPE_KEYS,'scope');const result={...scope};
 for(const key of ['repository','project_id','task_id','worker_ref','session_id','generation'])text(scope[key],key);
 if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(scope.repository))hold('Invalid repository');
 if(!Number.isSafeInteger(scope.pr_number)||scope.pr_number<1)hold('Invalid PR binding');
 hash(scope.head_sha,40,'head_sha');hash(scope.tree_sha,40,'tree_sha');hash(scope.input_digest,64,'input_digest');
 if(scope.prior_invocation_id!==null)id(scope.prior_invocation_id,'prior_invocation_id');
 return result;
}
function timestamp(value,label){text(value,label);const date=new Date(value);if(!Number.isFinite(date.getTime())||date.toISOString()!==value)hold(`Invalid ${label}`);return date.getTime();}
function unique(values,label,validate){if(!Array.isArray(values)||values.length>128)hold(`Invalid ${label}`);values.forEach(v=>validate(v,label));if(new Set(values.map(canonicalAuthorityJson)).size!==values.length)hold(`Duplicate ${label}`);return values;}
function forbidSecrets(value){if(value&&typeof value==='object'){for(const [key,v] of Object.entries(value)){if(/secret|password|credential|token|private.?key/i.test(key))hold('Authority record contains forbidden secret material');forbidSecrets(v);}}}
export function normalizeOwnerAuthorityEvent(event) {
 exact(event,['schema_version','event_id','kind','owner_ref','source_ref','issued_at','expires_at','scope','allowed_actions','prohibited_actions','supersedes','revokes','dependency_gates'],'event');
 forbidSecrets(event);if(event.schema_version!==OWNER_AUTHORITY_SCHEMA)hold('Unsupported authority version');
 id(event.event_id,'event_id');text(event.owner_ref,'owner_ref');text(event.source_ref,'source_ref');
 if(!['grant','revoke'].includes(event.kind))hold('Invalid authority event kind');
 if(timestamp(event.expires_at,'expires_at')<=timestamp(event.issued_at,'issued_at'))hold('Invalid authority lifetime');
 normalizeOwnerScope(event.scope);
 for(const key of ['allowed_actions','prohibited_actions'])unique(event[key],key,v=>{if(!EFFECTS.has(v))hold('Unsupported effect');});
 for(const key of ['supersedes','revokes'])unique(event[key],key,id);
 if(event.supersedes.includes(event.event_id)||event.revokes.includes(event.event_id))hold('Self authority reference');
 if(event.kind==='revoke' && (event.allowed_actions.length||event.prohibited_actions.length||!event.revokes.length))hold('Invalid revocation');
 if(event.kind==='grant' && (!event.allowed_actions.length&&!event.prohibited_actions.length||event.revokes.length))hold('Invalid grant');
 unique(event.dependency_gates,'dependency_gates',gate=>{exact(gate,['gate_id','evidence_sha256'],'gate');id(gate.gate_id,'gate_id');hash(gate.evidence_sha256,64,'evidence_sha256');});
 return JSON.parse(canonicalAuthorityJson(event));
}
function secureDirectory(directory,{create=false}={}) {
 if(!path.isAbsolute(directory))hold('Authority store must be absolute');
 // Validate existing ancestors before creating any child through them.
 const ancestors=[];for(let current=path.resolve(directory);;current=path.dirname(current)){ancestors.unshift(current);if(path.dirname(current)===current)break;}
 for(const current of ancestors){
  if(!fs.existsSync(current)){if(!create)hold('Missing authority store');fs.mkdirSync(current,{mode:0o700});}
  const info=fs.lstatSync(current);if(info.isSymbolicLink()||!info.isDirectory())hold('Authority store symlink/non-directory');
 }
 const info=fs.statSync(directory);if(info.mode&0o077 || process.getuid&&info.uid!==process.getuid())hold('Authority store must be privately owned');
}
function readPrivate(file) {
 const fd=fs.openSync(file,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
 try {
  const info=fs.fstatSync(fd);if(!info.isFile()||info.nlink!==1||info.size>1024*1024||info.mode&0o077||process.getuid&&info.uid!==process.getuid())hold('Untrusted authority file custody');
  return JSON.parse(fs.readFileSync(fd,'utf8'));
 } finally {fs.closeSync(fd);}
}
function syncDirectory(directory){const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function writeExclusive(file,value) {
 const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,canonicalAuthorityJson(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}syncDirectory(path.dirname(file));
}
export function createOwnerAuthorityLedger({directory,ownerRef,verifySource,verifyGate,clock=()=>new Date()}) {
 text(ownerRef,'pinned owner');if(typeof verifySource!=='function')hold('Trusted host source verifier required');
 async function verified(envelope) {
  exact(envelope,['event','source_proof','event_sha256'],'envelope');forbidSecrets(envelope.source_proof);
  const event=normalizeOwnerAuthorityEvent(envelope.event),canonical=canonicalAuthorityJson(event);
  if(envelope.event_sha256!==authorityDigest(event)||event.owner_ref!==ownerRef)hold('Owner/event identity mismatch');
  const source=await verifySource({canonical,event_sha256:envelope.event_sha256,sourceProof:envelope.source_proof});
  if(!source||source.owner_ref!==ownerRef||source.source_ref!==event.source_ref)hold('Unverified Owner source');
  return event;
 }
 async function readEvents() {
  secureDirectory(directory);const events=new Map();
  for(const name of fs.readdirSync(directory)) {
   if(name==='consumed'||name==='.mutation-lock')continue;
   if(!/^[a-zA-Z0-9_-]{1,128}\.json$/.test(name))hold('Unknown authority custody member');
   const envelope=readPrivate(path.join(directory,name));const event=await verified(envelope);
   if(name!==event.event_id+'.json'||events.has(event.event_id))hold('Authority ID substitution');events.set(event.event_id,event);
   if(events.size>1024)hold('Authority ledger size limit');
  }
  validateGraph(events);return events;
 }
 function validateGraph(events) {
  const visiting=new Set(),visited=new Set();
  function visit(event){if(visiting.has(event.event_id))hold('Cyclic supersession');if(visited.has(event.event_id))return;visiting.add(event.event_id);
   for(const ref of [...event.supersedes,...event.revokes]){const previous=events.get(ref);if(!previous)hold('Missing authority predecessor');if(canonicalAuthorityJson(previous.scope)!==canonicalAuthorityJson(event.scope)||previous.owner_ref!==event.owner_ref)hold('Cross-scope supersession');visit(previous);}
   visiting.delete(event.event_id);visited.add(event.event_id);
  }
  for(const event of events.values())visit(event);
 }
 function derive(events,scope,action) {
  normalizeOwnerScope(scope);if(!EFFECTS.has(action))hold('Unsupported authority effect');
  if(action==='execution.run' && scope.prior_invocation_id!==null || action==='execution.rerun' && scope.prior_invocation_id===null)hold('Execution action/prior invocation mismatch');
  const applicable=[...events.values()].filter(event=>canonicalAuthorityJson(event.scope)===canonicalAuthorityJson(scope));
  const superseded=new Set(applicable.flatMap(event=>event.supersedes));
  const revoked=new Set(applicable.flatMap(event=>event.revokes));
  const heads=applicable.filter(event=>event.kind==='grant'&&!superseded.has(event.event_id));
  if(heads.length!==1)hold('Missing or incomparable effective authority');const current=heads[0];
  const now=clock();if(!(now instanceof Date)||!Number.isFinite(now.getTime()))hold('Clock uncertain');
  if(revoked.has(current.event_id)||now.getTime()<timestamp(current.issued_at,'issued_at')||now.getTime()>=timestamp(current.expires_at,'expires_at'))hold('Expired/revoked effective authority');
  if(current.prohibited_actions.includes(action)||!current.allowed_actions.includes(action))hold('Effect outside current Owner scope');
  return {event:current,event_sha256:authorityDigest(current)};
 }
 async function withLock(action,{create=false}={}) {
  secureDirectory(directory,{create});const lock=path.join(directory,'.mutation-lock');
  try{fs.mkdirSync(lock,{mode:0o700});}catch(error){if(error.code==='EEXIST')hold('Authority mutation already active or interrupted');throw error;}
  const token=crypto.randomUUID();writeExclusive(path.join(lock,'owner.json'),{token,pid:process.pid});syncDirectory(directory);
  try{return await action();}finally{
   // Only this exact owned lock is released; stale or replaced locks remain HOLD.
   const owner=readPrivate(path.join(lock,'owner.json'));if(owner.token!==token)hold('Authority lock ownership changed');
   fs.unlinkSync(path.join(lock,'owner.json'));fs.rmdirSync(lock);syncDirectory(directory);
  }
 }
 return {
  async ingest(event,sourceProof) {
   event=normalizeOwnerAuthorityEvent(event);sourceProof=JSON.parse(canonicalAuthorityJson(sourceProof));
   return withLock(async()=>{
    const envelope={event:normalizeOwnerAuthorityEvent(event),source_proof:sourceProof,event_sha256:authorityDigest(normalizeOwnerAuthorityEvent(event))};await verified(envelope);
    const events=await readEvents(),existing=events.get(envelope.event.event_id);
    if(existing){if(authorityDigest(existing)!==envelope.event_sha256)hold('Duplicate authority ID with different bytes');return {event_id:existing.event_id,duplicate:true};}
    events.set(envelope.event.event_id,envelope.event);validateGraph(events);
    writeExclusive(path.join(directory,envelope.event.event_id+'.json'),envelope);return {event_id:envelope.event.event_id,event_sha256:envelope.event_sha256};
   },{create:true});
  },
  async inspect(scope,action){return withLock(async()=>derive(await readEvents(),scope,action));},
  async consumeAndPermit({scope,action,invocationId,gateProofs=[]},permit) {
   scope=normalizeOwnerScope(scope);gateProofs=JSON.parse(canonicalAuthorityJson(gateProofs));
   id(invocationId,'invocationId');if(typeof permit!=='function')hold('Effect permit callback required');
   return withLock(async()=>{
    const authority=derive(await readEvents(),scope,action);
    for(const gate of authority.event.dependency_gates){if(typeof verifyGate!=='function'||await verifyGate({gate,proofs:gateProofs,scope})!==true)hold('Dependency gate not verified');}
    const consumed=path.join(directory,'consumed');secureDirectory(consumed,{create:true});
    const key=authorityDigest({event_sha256:authority.event_sha256,action});const receipt=path.join(consumed,key+'.json');
    if(fs.existsSync(receipt))hold('Authority effect already consumed');
    writeExclusive(receipt,{schema_version:'ao.owner-authority-consumption.v1',event_sha256:authority.event_sha256,action,invocation_id:invocationId,scope,consumed_at:clock().toISOString()});
    // Linearization: durable consumption before permit initiation while the shared mutation lock is held.
    return await permit(authority);
   });
  },
 };
}
