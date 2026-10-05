const readline=require('node:readline');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
readline.createInterface({input:process.stdin}).on('line',async line=>{
 const {id,url,direct,hello}=JSON.parse(line);
 if(hello){process.stdout.write(JSON.stringify({id,pid:process.pid,hello:true})+'\n');return;}
 try{const r=await run('/usr/bin/curl',['--max-time','5','-sS',...(direct?['--noproxy','*']:[]),url]);process.stdout.write(JSON.stringify({id,pid:process.pid,exit:0,body:r.stdout})+'\n');}
 catch(e){process.stdout.write(JSON.stringify({id,pid:process.pid,exit:e.code,body:e.stdout??'',error:e.stderr??''})+'\n');}
});
