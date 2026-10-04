import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withEgressExecution } from './runtime.js';
import { gateError } from './plan.js';
import { resolveEngagementSession } from '../context.js';
import { executeConfinedFileTool } from './file-tools.js';
import { homedir } from 'node:os';
import { dshHomeOf, readCapsManifest } from '../capability-loader.js';

// Unadapted sending tools are unavailable rather than allowed by a prompt.
const UNADAPTED=new Set(['src_add_capability','src_test_capability','src_serve_proof','src_stop_serve','web_fetch']);
// Audited catalog. New plugins/tools do not acquire target authority by a src_ prefix.
const SRC_TOOLS=new Set(["src_add_asset", "src_add_capability", "src_add_fact", "src_add_finding", "src_add_goal", "src_add_intent", "src_add_test_account", "src_audit", "src_collect_dorks", "src_collect_passive", "src_egress_plan", "src_egress_prepare", "src_fetch_policy", "src_finalize_engagement", "src_get_evidence", "src_get_infra", "src_graph", "src_http", "src_import_traffic", "src_list_capabilities", "src_list_domain_notes", "src_read_capability", "src_read_lesson", "src_reclassify_finding", "src_recon", "src_record_coverage", "src_record_domain_note", "src_record_lesson", "src_record_observation", "src_record_research", "src_recover_child", "src_reject_finding", "src_report", "src_request_asset_confirm", "src_resolve_approval", "src_run_capability", "src_scan_surface", "src_search_lessons", "src_serve_proof", "src_set_goal_target", "src_set_infra", "src_state", "src_stop_serve", "src_submit", "src_survey_seed", "src_test_bypass", "src_test_capability", "src_test_credential", "src_update_finding", "src_update_intent", "src_user_todo", "src_verify"]);
const LOCAL=new Set(['bash','read','write','edit','read_image','glob','grep','skill','todo','ask_user_question','job_list','job_output','job_kill','web_search']);
async function resolvedTarget(filename) {
  let target=path.resolve(filename),suffix=[];
  for(;;){try{return path.join(await realpath(target),...suffix);}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(target);if(parent===target)throw error;suffix.unshift(path.basename(target));target=parent;}}
}
function within(target,root){return target===root||target.startsWith(root+path.sep);}
export function installEgressExecution(ctx,store,service) {
  const packageRoot=fileURLToPath(new URL('../../../',import.meta.url));
  ctx.on('tools/execute',async(exec,next)=>{
    if(ctx.shell?.srcEgressPolicyVersion!==1)throw gateError('UNGUARDED_EXECUTOR');
    const actualSession=exec.agent?.session?.id;
    if(!actualSession)throw gateError('MISSING_SESSION');
    service.own(actualSession);
    const name=String(exec.name);
    if(UNADAPTED.has(name)||(!SRC_TOOLS.has(name)&&!LOCAL.has(name)))throw gateError('UNADAPTED_TOOL');
    const manager=await service.ready();
    const sessionId=await resolveEngagementSession(store,ctx,exec)??actualSession;
    const privateHome=await realpath(dshHomeOf());
    const protectedPaths=[dshHomeOf(),privateHome,packageRoot,await realpath(packageRoot)];
    const forbiddenCapRoots=['control','storages','sessions','profiles','settings','tools','.credentials.yaml','settings.yaml','capabilities.yaml','capabilities/index.json'].map(p=>path.join(privateHome,p));
    forbiddenCapRoots.push(await realpath(packageRoot));
    const capabilities=await readCapsManifest(dshHomeOf());
    const readablePaths=[];
    for(const item of capabilities.items??[]){
      if(item.status!=='installed'||typeof item.dir!=='string')continue;
      const root=await realpath(item.dir);
      if(forbiddenCapRoots.some(control=>within(control,root)||within(root,control)))throw gateError('INVALID_CAPABILITY_ROOT');
      readablePaths.push(root);
    }
    const home=homedir();
    const workspace=exec.agent.session.header?.cwd??process.cwd();
    const instructionPaths=['.agents','.dsh','.codex','.opencode','AGENTS.md','CLAUDE.md'].map(p=>path.join(workspace,p));
    const platformReadOnly=[...(process.env.DSH_SRC_LESSONS_DIR?[path.resolve(process.env.DSH_SRC_LESSONS_DIR)]:[]),...instructionPaths,...readablePaths,'/Library','/System','/usr','/bin','/sbin','/etc','/private/etc','/private/var/db','/private/var/spool',path.join(home,'Library'),...['.ssh','.config','.local','.zshrc','.bashrc','.bash_profile','.profile','.npmrc'].map(p=>path.join(home,p))];
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
    const proxy=fileTool?{denyNetwork:true,alive:()=>true,protectedPaths:[],readOnlyPaths:[]}:name==='bash'?await manager.sessionProxy(sessionId):undefined;
    return withEgressExecution({ctx,manager,sessionId,exec,proxy,protectedPaths,readablePaths,readOnlyPaths:platformReadOnly},fileTool?()=>executeConfinedFileTool(ctx,exec):next);
  });
}
