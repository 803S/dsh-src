import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '/Users/lihua-dis/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const dir=path.dirname(fileURLToPath(import.meta.url));
const browser=await chromium.launch({headless:true,channel:'chrome'});
const page=await browser.newPage({viewport:{width:1500,height:1000},deviceScaleFactor:1});
await page.setContent('<!doctype html><html><body></body></html>');
await page.addScriptTag({path:path.join(dir,'mermaid-renderer.tmp.js')});
await page.evaluate(()=>mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'base',fontFamily:'Arial, PingFang SC, sans-serif',themeVariables:{primaryColor:'#eef4fb',primaryTextColor:'#192d45',primaryBorderColor:'#9ab0ca',lineColor:'#6c7f96',secondaryColor:'#f5f0fc',tertiaryColor:'#f6f8fb',clusterBkg:'#f9fafc',clusterBorder:'#d9e1ec',fontSize:'16px',actorBkg:'#eee4fb',actorBorder:'#9670bd',actorTextColor:'#352247',signalColor:'#596d85',signalTextColor:'#25364b',noteBkgColor:'#fff3da',noteTextColor:'#674414'},flowchart:{htmlLabels:false,curve:'basis',nodeSpacing:28,rankSpacing:44,padding:16},sequence:{useMaxWidth:false,wrap:true,actorMargin:35,messageMargin:34}}));
const graphs=JSON.parse(await fs.readFile(path.join(dir,'diagrams.json'),'utf8'));
let html=await fs.readFile(path.join(dir,'template.html'),'utf8');
for(const graph of graphs){
 try{
  let svg=await page.evaluate(async g=>(await mermaid.render('dsh_'+g.id,g.code)).svg,graph);
  svg=svg.replace('<svg ',`<svg role="img" aria-label="${graph.title}" `);
  await fs.writeFile(path.join(dir,graph.id+'.svg'),svg);
  html=html.replace('@@SVG:'+graph.id+'@@',svg);
  console.log('Rendered',graph.id);
 }catch(error){console.error('Failed',graph.id,error);await browser.close();process.exit(1);}
}
await fs.writeFile(path.join(dir,'architecture.html'),html);
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto('file://'+path.join(dir,'architecture.html'));
await page.screenshot({path:path.join(dir,'preview.png'),fullPage:false});
const desktop=await page.evaluate(()=>({diagrams:document.querySelectorAll('.drawing svg').length,overflow:document.documentElement.scrollWidth>innerWidth,placeholders:document.body.innerText.includes('@@SVG'),texts:[...document.querySelectorAll('.drawing svg')].map(s=>({id:s.id,w:s.getBoundingClientRect().width,h:s.getBoundingClientRect().height}))}));
await page.locator('#jev [data-action="fit"]').click();
await page.locator('#jev [data-action="plus"]').click();
const zoom=await page.locator('#jev .drawing').evaluate(e=>e.style.width);
await page.locator('#jev [data-action="expand"]').click();
const expanded=await page.locator('#jev').evaluate(e=>e.classList.contains('expanded'));
await page.keyboard.press('Escape');
const escaped=await page.locator('#jev').evaluate(e=>!e.classList.contains('expanded'));
await page.locator('#jev [data-action="fit"]').click();
await page.setViewportSize({width:390,height:844});
await page.goto('file://'+path.join(dir,'architecture.html'));
const mobile=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,diagrams:document.querySelectorAll('.drawing svg').length}));
await page.screenshot({path:path.join(dir,'mobile-preview.png'),fullPage:false});
const result={desktop,mobile,zoom,expanded,escaped,errors};
await fs.writeFile(path.join(dir,'validation.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
await browser.close();
if(errors.length||desktop.overflow||mobile.overflow||desktop.diagrams!==8||zoom!=='125%'||!expanded||!escaped)process.exit(1);
