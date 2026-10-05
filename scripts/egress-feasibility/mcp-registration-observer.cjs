// Evaluation-only transparent stdio observer. The real installed CLI and native
// DSH MCP bridge perform discovery. Record method names only, never tool args.
const {spawn}=require('node:child_process');
const {appendFileSync}=require('node:fs');
const [entry,trace,interpreter=process.execPath]=process.argv.slice(2);
const child=spawn(interpreter,[entry],{stdio:['pipe','pipe','inherit']});
let pending='';
process.stdin.on('data',chunk=>{
 pending+=chunk.toString('utf8');
 while(pending.includes('\n')){
  const i=pending.indexOf('\n'),line=pending.slice(0,i);pending=pending.slice(i+1);
  try{const msg=JSON.parse(line);if(typeof msg.method==='string')appendFileSync(trace,JSON.stringify({type:'native-mcp-registry-wire',method:msg.method,...(process.env.DSH_EVAL_REAL_BURP_HISTORY==='1'&&msg.method==='tools/call'?{toolName:msg.params?.name}:{})})+'\n');}catch{}
 }
 if(pending.length>1048576)pending='';
});
process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);
child.on('error',()=>process.exit(1));
child.stdin.on('error',()=>{});
child.on('exit',code=>process.exit(code??1));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
