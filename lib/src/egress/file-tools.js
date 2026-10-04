// Native model-facing file tool names, but I/O happens inside the same kernel
// confinement as bash. A pre-read realpath check in the DSH process is racy.
import path from 'node:path';
import { gateError } from './plan.js';
const PROGRAM = `import json,sys,os
x=json.load(sys.stdin); op=x['op']; a=x['args']; p=a.get('file_path','')
def read_text():
 with open(p,'r',encoding='utf-8') as f: text=f.read(4194305)
 if len(text)>4194304: raise ValueError('file size limit')
 return text
if op=='read':
 offset=a.get('offset',1); limit=a.get('limit',2000)
 if type(offset)!=int or offset<1 or type(limit)!=int or limit<1 or limit>10000: raise ValueError('invalid read range')
 lines=read_text().splitlines(); rows=[]; size=0
 for i,line in enumerate(lines,1):
  if i<offset: continue
  if len(rows)>=limit: break
  size+=len(line.encode('utf-8'))
  if size>65536: break
  rows.append({'number':i,'text':line})
 print(json.dumps({'path':p,'offset':offset,'lines':rows,'totalLines':len(lines)}))
elif op=='write':
 content=a['content']
 if not isinstance(content,str): raise ValueError('content must be text')
 before=read_text() if os.path.exists(p) else None
 with open(p,'w',encoding='utf-8') as f: f.write(content)
 print(json.dumps({'path':p,'operation':'create' if before is None else 'update','before':before,'after':content}))
elif op=='edit':
 old=a['old_string']; new=a['new_string']
 if not isinstance(old,str) or not old or not isinstance(new,str): raise ValueError('invalid literal edit')
 before=read_text(); count=before.count(old)
 if not count or (not a.get('replace_all',False) and count!=1): raise ValueError('old_string must match exactly')
 text=before.replace(old,new) if a.get('replace_all',False) else before.replace(old,new,1)
 with open(p,'w',encoding='utf-8') as f: f.write(text)
 print(json.dumps({'path':p,'before':before,'after':text}))
elif op=='read_image':
 import base64
 with open(p,'rb') as f: data=f.read(x['byteCap']+1)
 if len(data)>x['byteCap']: raise ValueError('image size limit')
 print(base64.b64encode(data).decode('ascii'))
else: raise ValueError('unsupported file operation')
`;
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
export async function executeConfinedFileTool(ctx,exec) {
  if(exec.arguments?.sandbox_permissions)throw gateError('USE_BASH_FOR_NATIVE_ESCALATION');
  const policy=ctx.get('sandboxPolicy').resolve({session:exec.agent.session});
  if(['glob','grep'].includes(exec.name))return executeSearch(ctx,exec,policy);
  const allowed=exec.name==='read_image'?['file_path']:exec.name==='read'?['file_path','offset','limit']:exec.name==='write'?['file_path','content']:['file_path','old_string','new_string','replace_all'];
  if(Object.keys(exec.arguments).some(key=>!allowed.includes(key))||typeof exec.arguments.file_path!=='string')throw gateError('INVALID_FILE_ARGUMENTS');
  const attachments=exec.name==='read_image'?ctx.get('attachments'):undefined;
  if(exec.name==='read_image'&&!attachments)throw gateError('IMAGE_SERVICE_UNAVAILABLE');
  const byteCap=attachments?Math.min(attachments.imageLimits.maxImageBytes,attachments.imageLimits.maxMessageImageBytes,2*1024*1024):0;
  const payload=JSON.stringify({op:exec.name,args:exec.arguments,byteCap});
  if(Buffer.byteLength(payload)>4*1024*1024)throw gateError('FILE_ARGUMENT_LIMIT');
  const spec=ctx.shell.resolve({command:`/usr/bin/python3 -c ${quote(PROGRAM)}`,stdin:payload,stdoutMaxBytes:byteCap?Math.ceil(byteCap/3)*4+8:64*1024*1024,workdir:policy.workspaceRoot,sandboxPolicy:policy,signal:exec.signal});
  const result=await ctx.shell.run(spec);
  const output=result.stdout?.text??'',error=result.stderr?.text??'';
  if(exec.name==='read_image'&&result.exitCode===0){
    const mediaType={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'}[path.extname(exec.arguments.file_path).toLowerCase()];
    if(!mediaType)throw gateError('UNSUPPORTED_IMAGE');
    const ref=await attachments.saveImage({data:Buffer.from(output.trim(),'base64'),mediaType,name:path.basename(exec.arguments.file_path)});
    return {content:[{type:'text',text:`Read image ${exec.arguments.file_path}`},{type:'image',attachment:ref}],value:{path:exec.arguments.file_path,image:ref}};
  }
  if(result.exitCode!==0)throw new Error(error||'Confined file operation failed');
  const value=JSON.parse(output);
  return {content:[{type:'text',text:exec.name==='read'?value.lines.map(row=>`${row.number}\t${row.text}`).join('\n'):`${exec.name}: ${value.path}`}],value};
}

async function executeSearch(ctx,exec,policy) {
  const args=exec.arguments,glob=exec.name==='glob';
  const allowed=glob?['pattern','path']:['pattern','path','include'];
  if(Object.keys(args).some(key=>!allowed.includes(key))||typeof args.pattern!=='string'||args.pattern.length>2048||args.path!==undefined&&typeof args.path!=='string'||args.include!==undefined&&typeof args.include!=='string')throw gateError('INVALID_FILE_ARGUMENTS');
  const argv=glob?['rg','--files','--null','--hidden','--no-ignore','-g','!.git/**','-g',args.pattern,'--',args.path??'.']:
    ['rg','--json','--line-number','--no-heading','--hidden','--no-ignore','--max-count','200','--max-filesize','4M','-g','!.git/**',...(args.include?['-g',args.include]:[]),'--',args.pattern,args.path??'.'];
  const result=await ctx.shell.run(ctx.shell.resolve({command:argv.map(quote).join(' '),workdir:policy.workspaceRoot,sandboxPolicy:policy,signal:exec.signal,timeoutMs:15000,stdoutMaxBytes:65536}));
  const text=(result.stdout?.text??'')+(result.stderr?.text?'\n'+result.stderr.text:'');
  if(result.exitCode!==0&&result.exitCode!==1)throw new Error(text||'Confined search failed');
  const root=path.resolve(policy.workspaceRoot,args.path??'.');
  const value=glob?{root,paths:(result.stdout?.text??'').split('\0').filter(Boolean)}:{matches:(result.stdout?.text??'').split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.type==='match').map(({data})=>({path:data.path.text,lineNumber:data.line_number,line:data.lines.text.replace(/\n$/,'')}))};
  return {content:[{type:'text',text:JSON.stringify(value)}],value};
}
