import {teamClaimDecision} from './team-workflow.js';
import {isFofaTool} from './fofa.js';
import {guardGoalTool} from './goal-tools.js';
import {isBurpPassiveTool,passiveBurpArguments} from './burp-passive.js';
import {isBurpSendTool,createBurpSender} from './burp-request.js';
import {isTeamTool,isDelegationControl,normalizeTeamArguments} from './delegation.js';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withEgressExecution } from './runtime.js';
import { gateError } from './plan.js';
import { resolveEngagementSession } from '../context.js';
import { executeConfinedFileTool } from './file-tools.js';
import { executeGuardedWebFetch } from './web-fetch.js';
import { homedir } from 'node:os';
import { dshHomeOf, readCapsManifest } from '../capability-loader.js';
import {createBrowserAdapter,isBrowserTool} from './browser-adapter.js';

// Unadapted sending tools are unavailable rather than allowed by a prompt.
const UNADAPTED=new Set(['src_add_capability']);
// Audited catalog. New plugins/tools do not acquire target authority by a src_ prefix.
const SRC_TOOLS=new Set(["src_add_asset", "src_add_capability", "src_add_fact", "src_add_finding", "src_add_goal", "src_add_intent", "src_add_test_account", "src_audit", "src_collect_dorks", "src_collect_passive", "src_egress_plan", "src_egress_prepare", "src_fetch_policy", "src_finalize_engagement", "src_get_evidence", "src_get_infra", "src_graph", "src_http", "src_import_traffic", "src_list_capabilities", "src_list_domain_notes", "src_read_capability", "src_read_lesson", "src_reclassify_finding", "src_recon", "src_record_coverage", "src_record_domain_note", "src_record_lesson", "src_record_observation", "src_record_research", "src_recover_child", "src_reject_finding", "src_report", "src_request_asset_confirm", "src_resolve_approval", "src_run_capability", "src_scan_surface", "src_search_lessons", "src_serve_proof", "src_set_goal_target", "src_set_infra", "src_state", "src_stop_serve", "src_submit", "src_survey_seed", "src_test_bypass", "src_test_capability", "src_test_credential", "src_update_finding", "src_update_intent", "src_user_todo", "src_verify"]);
const LOCAL=new Set(['bash','read','write','edit','read_image','glob','grep','skill','todo','todo_write','get_goal','create_goal','update_goal','ask_user_question','job_list','job_output','job_kill','web_search','web_fetch']);
async function resolvedTarget(filename) {
  let target=path.resolve(filename),suffix=[];
  for(;;){try{return path.join(await realpath(target),...suffix);}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(target);if(parent===target)throw error;suffix.unshift(path.basename(target));target=parent;}}
}
function within(target,root){return target===root||target.startsWith(root+path.sep);}
export async function capabilityPolicyRoots(items,forbiddenRoots){
  const readablePaths=[],readOnlyPaths=[];
  for(const item of items??[]){
    if(item.status!=='installed'||typeof item.dir!=='string')continue;
    if(!path.isAbsolute(item.dir))throw gateError('INVALID_CAPABILITY_ROOT');
    let root,exists=true;
    try{root=await realpath(item.dir);}catch(error){
      if(error.code!=='ENOENT')throw error;
      // A stale optional installation must not disable unrelated tools. Keep
      // its future path write-protected, but grant no readable exception.
      exists=false;root=await resolvedTarget(item.dir);
    }
    if(forbiddenRoots.some(control=>within(control,root)||within(root,control)))throw gateError('INVALID_CAPABILITY_ROOT');
    readOnlyPaths.push(path.resolve(item.dir),root);
    if(exists)readablePaths.push(root);
  }
  return {readablePaths:[...new Set(readablePaths)],readOnlyPaths:[...new Set(readOnlyPaths)]};
}
export function validateToolIdentity(exec){
 if(typeof exec.name!=='string'||!exec.name.trim()||typeof exec.callId!=='string'||!exec.callId.trim())throw Object.assign(gateError('MALFORMED_TOOL_CALL'),{message:'SRC_GATE_MALFORMED_TOOL_CALL：模型返回了空工具名或调用ID；未执行。这不是工具未适配，不要换网络通道。'});
}
export function installEgressExecution(ctx,store,service) {
  const packageRoot=fileURLToPath(new URL('../../../',import.meta.url));
  const browser=createBrowserAdapter(ctx,store);
  const sendBurp=createBurpSender(ctx,store);
  ctx.on('tools/post-execute',async(exec,result,next)=>teamClaimDecision(exec,result,await next()));
  ctx.on('tools/execute',async(exec,next)=>{
    if(ctx.shell?.srcEgressPolicyVersion!==1)throw gateError('UNGUARDED_EXECUTOR');
    const actualSession=exec.agent?.session?.id;
    if(!actualSession)throw gateError('MISSING_SESSION');
    service.own(actualSession);
    validateToolIdentity(exec);
    const name=String(exec.name);
    guardGoalTool(name,exec.agent.session);
    const browserTool=isBrowserTool(name),fofaTool=isFofaTool(name),teamTool=isTeamTool(name),delegationControl=isDelegationControl(name);
    const burpPassive=isBurpPassiveTool(name);
    const burpSend=isBurpSendTool(name);
    if(burpSend&&!ctx.tools.get(name,exec.agent))throw gateError('UNAVAILABLE_TOOL');
    if(burpPassive){if(!ctx.tools.get(name,exec.agent))throw gateError('UNAVAILABLE_TOOL');exec.arguments=passiveBurpArguments(name,exec.arguments);}
    if((teamTool||delegationControl)&&(!ctx.tools.get(name,exec.agent)||!service.delegationReady?.()))throw gateError('UNGUARDED_DELEGATION');
    if(teamTool)exec.arguments=normalizeTeamArguments(name,exec.arguments);
    // Around adapters must not execute a tool hidden or absent in this agent's
    // registry; native dispatch would otherwise reject only after our I/O.
    if((browserTool||fofaTool||['web_fetch','read','write','edit','read_image','glob','grep'].includes(name))&&!ctx.tools.get(name,exec.agent))throw gateError('UNAVAILABLE_TOOL');
    if(UNADAPTED.has(name)||(!SRC_TOOLS.has(name)&&!LOCAL.has(name)&&!browserTool&&!fofaTool&&!teamTool&&!delegationControl&&!burpPassive&&!burpSend))throw gateError('UNADAPTED_TOOL');
    const manager=await service.ready();
    const sessionId=await resolveEngagementSession(store,ctx,exec)??actualSession;
    // 纯记录/本地工作不依赖目标DNS是否可用；仅在出网工具前接入人类范围。
    if(browserTool||burpSend||['bash','src_http','web_fetch','src_scan_surface','src_collect_passive','src_recon','src_test_bypass','src_test_credential','src_run_capability','src_test_capability','src_egress_plan','src_egress_prepare','src_survey_seed'].includes(name))
      await manager.user.seedScope?.(sessionId,sessionId===actualSession?exec.agent.session:ctx.sessions?.get(sessionId));
    if(name==='src_http')manager.checkTarget(sessionId,exec.arguments?.url);
    const privateHome=await realpath(dshHomeOf());
    const protectedPaths=[dshHomeOf(),privateHome,packageRoot,await realpath(packageRoot)];
    const forbiddenCapRoots=['control','storages','sessions','profiles','settings','tools','.credentials.yaml','settings.yaml','capabilities.yaml','capabilities/index.json'].map(p=>path.join(privateHome,p));
    forbiddenCapRoots.push(await realpath(packageRoot));
    const capabilities=await readCapsManifest(dshHomeOf());
    if(fofaTool){
      if(!capabilities.items.some(item=>item.id==='fofa'&&item.kind==='mcp'&&item.status==='installed'&&item.enabled!==false)||typeof service.fofaLookup!=='function')throw gateError('FOFA_NOT_INSTALLED');
      return service.fofaLookup(exec,sessionId);
    }
    const {readablePaths,readOnlyPaths:capabilityReadOnlyPaths}=await capabilityPolicyRoots(capabilities.items,forbiddenCapRoots);
    const home=homedir();
    const workspace=exec.agent.session.header?.cwd??process.cwd();
    const instructionPaths=['.agents','.dsh','.codex','.opencode','AGENTS.md','CLAUDE.md'].map(p=>path.join(workspace,p));
    const platformReadOnly=[...(process.env.DSH_SRC_LESSONS_DIR?[path.resolve(process.env.DSH_SRC_LESSONS_DIR)]:[]),...instructionPaths,...capabilityReadOnlyPaths,'/Library','/System','/usr','/bin','/sbin','/etc','/private/etc','/private/var/db','/private/var/spool',path.join(home,'Library'),...['.ssh','.config','.local','.zshrc','.bashrc','.bash_profile','.profile','.npmrc'].map(p=>path.join(home,p))];
    // Native file tools run in host process, so shell SBPL alone cannot protect
    // approval keys/config/deployment or the live DSH command/event stores.
    if(['read','write','edit','read_image','glob','grep'].includes(name)){
      const candidate=exec.arguments?.file_path??exec.arguments?.path??exec.arguments?.directory??exec.agent.session.header?.cwd??process.cwd();
      if(typeof candidate!=='string')throw gateError('UNKNOWN_FILE_TOOL_PATH');
      const cwd=exec.agent.session.header?.cwd??process.cwd();
      const target=await resolvedTarget(path.resolve(cwd,candidate));
      for(const root of protectedPaths){const resolved=await resolvedTarget(root);if(within(target,resolved)||within(resolved,target))throw gateError('PROTECTED_CONTROL_PATH');}
    }
    const fileTool=['read','write','edit','read_image','glob','grep'].includes(name);
    // Local file adapters need no network and must not start an 80+MiB TLS proxy.
    const shell=name==='bash'?await manager.shellExecution(sessionId):undefined;
    const proxy=fileTool?{denyNetwork:true,alive:()=>true,protectedPaths:[],readOnlyPaths:[]}:shell?.proxy;
    try{return await withEgressExecution({ctx,manager,sessionId,exec,proxy,shellTaskId:shell?.taskId,protectedPaths,readablePaths,readOnlyPaths:platformReadOnly},fileTool?()=>executeConfinedFileTool(ctx,exec):name==='web_fetch'?()=>executeGuardedWebFetch(exec):browserTool?()=>browser.execute(exec,capabilities.items):burpSend?()=>sendBurp(exec):next);}
    finally{if(shell?.taskId)await manager.releaseShellProxy(sessionId,shell.taskId,shell.proxy);}
  });
}
