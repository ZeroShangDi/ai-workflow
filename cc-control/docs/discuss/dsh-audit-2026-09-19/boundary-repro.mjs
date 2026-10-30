import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(repo, 'package.json'));
const { createDshBridge } = require('./server/adapters/dsh/bridge.cjs');
const { createDshAdapters } = require('./server/adapters/dsh/index.cjs');
const { createOps } = await import(pathToFileURL(path.join(repo, 'dsh-plugin/lib/ops.js')));
const results = [];
const record = (name, result) => { results.push({name, ...result}); console.log(JSON.stringify(results.at(-1))); };
// R1: actual CLI assembly, no server/network/model side effects.
const root = fs.mkdtempSync('/tmp/dsh-audit-');
fs.mkdirSync(path.join(root,'.awf'));
fs.writeFileSync(path.join(root,'.awf/config.json'), JSON.stringify({runtime:{adapter:'dsh'}}));
const { buildContext } = require('./cli/lib/context.cjs');
const { ensureSession } = require('./cli/lib/session.cjs');
const errors = [];
const catcher = e => errors.push(e.message);
process.on('unhandledRejection', catcher);
const created = ensureSession(buildContext(root, {env:{}}));
await new Promise(r=>setTimeout(r,20));
process.removeListener('unhandledRejection', catcher);
record('R1 CLI ensureSession', {created, unhandledRejections:errors});
// R2: plan then execution in same project: newly-created execution session is ignored.
const old = {header:{id:'plan-old',cwd:root}};
const sessions = [old]; let promptTarget;
const services = {
 sessions:{list:()=>sessions},
 agents:{create:async ({sessionId,meta})=>{const agent={session:{header:{id:sessionId,cwd:meta.cwd}}};sessions.push(agent.session);return {agent};}},
 sessionController:{prompt:async req=>{promptTarget=req.sessionId;return {accepted:true};}},
};
const ops = createOps({ctx:{get:n=>services[n]}});
const made = await ops.dispatch({op:'session.create',args:{projectRoot:root}});
await ops.dispatch({op:'session.prompt',args:{projectRoot:root,text:'task'}});
record('R2 session identity', {createdSession:made.result.sessionId, actualPromptTarget:promptTarget});
// R3: accepted ack without result: controlled timer invokes the real timeout branch.
let command; const timers=[];
const bridge = createDshBridge({send:c=>{command=c},setTimer:fn=>{timers.push(fn);return timers.length;},clearTimer:()=>{}});
bridge.attach();
const adapter = createDshAdapters({bridge,projectRoot:root});
const launched = adapter.interactive.launchDialog({cwd:root,prompt:'plan'});
bridge.onCallback({commandId:command.commandId,phase:'accepted'});
timers.at(-1)();
record('R3 accepted result timeout', {returned:await launched});
// R4: shared facts pollutes project B, although no B session exists.
const shared = createDshBridge({send:()=>{}});shared.attach();
const a=createDshAdapters({bridge:shared,projectRoot:'/project-a'});
const b=createDshAdapters({bridge:shared,projectRoot:'/project-b'});
shared.onCallback({kind:'event',event:{type:'session.started',cwd:'/project-a',sessionId:'a'},facts:{sessionExists:true,cwd:'/project-a',sessionId:'a'}});
record('R4 shared facts', {bExists:b.session.exists(),bCwd:b.session.cwd()});
// R5: stop reports ok even if cancellation is refused and child interruption fails.
const stopOps=createOps({ctx:{get:n=>({sessions:{list:()=>[{header:{id:'main',cwd:root}},{header:{id:'child',parentSession:'main',cwd:root}}]},sessionController:{cancel:()=>({accepted:false})},subagents:{interrupt:()=>{throw Error('still running')}}}[n])}});
record('R5 stop failure', {returned:await stopOps.dispatch({op:'session.stop',args:{projectRoot:root}})});
fs.rmSync(root,{recursive:true,force:true});
