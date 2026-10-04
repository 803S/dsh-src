import {spawn} from 'node:child_process';import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import assert from 'node:assert/strict';
const profile=await mkdtemp('/private/tmp/src-ui-chrome-');const child=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',['--headless=new','--no-first-run','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
let ws;const wait=ms=>new Promise(r=>setTimeout(r,ms));
try{
 let port;for(let i=0;i<100;i++){try{port=(await readFile(profile+'/DevToolsActivePort','utf8')).split('\n')[0];break;}catch{await wait(50);}}
 assert.ok(port);const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();ws=new WebSocket(pages.find(p=>p.type==='page'&&p.url==='about:blank').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 let id=0;const pending=new Map();ws.onmessage=e=>{const r=JSON.parse(e.data);if(r.method==='Runtime.exceptionThrown')console.error(JSON.stringify(r.params));if(r.id){const p=pending.get(r.id);pending.delete(r.id);r.error?p.reject(r.error):p.resolve(r.result);}};
 const send=(method,params={})=>new Promise((resolve,reject)=>{pending.set(++id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
 await send('Page.enable');await send('Runtime.enable');await send('Emulation.setDeviceMetricsOverride',{width:1050,height:1000,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:'file:///private/tmp/src-egress-ui-qa/index.html'});await wait(500);
 assert.equal(await evaluate("document.querySelectorAll('summary').length"),1);
 await evaluate("document.querySelector('details').open=true");
 const set=async(label,value)=>{await evaluate(`(()=>{let e=document.querySelector('[aria-label="${label}"]');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(30);};
 const click=async(text)=>{await evaluate(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)}).click()`);await wait(30);};
 assert.equal(await evaluate("document.querySelector('button').disabled"),true);
 await set('目标 origins','https://example.com\nhttps://api.example.com:8443');await click('确认并替换范围');await click('查看当前范围和状态');
 await set('审批编号','approval-7');await click('查看完整脱敏计划');
 assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='记录核对，解除旧锁').disabled"),true);
 await set('核对依据','测试人员已核对目标日志与实际对象状态，确认该请求从未发送。');await click('记录核对，解除旧锁');
 const commands=await evaluate('window.commands');assert.equal(commands.length,4);assert.equal(commands[0],'/src-egress-scope ["https://example.com","https://api.example.com:8443"]');assert.equal(commands[2],'/src-egress-review approval-7');assert.match(commands[3],/^\/src-egress-reconcile approval-7 cancel-never-sent /);
 await writeFile('/private/tmp/src-egress-ui-qa/desktop.png',Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:1100,deviceScaleFactor:1,mobile:true});await wait(100);await writeFile('/private/tmp/src-egress-ui-qa/mobile.png',Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 console.log(JSON.stringify({passed:true,commands,scope:'actual React component, isolated mock command transport; not whole production UI'}));
}finally{ws?.close();child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));await rm(profile,{recursive:true,force:true});}
