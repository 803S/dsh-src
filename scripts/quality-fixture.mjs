#!/usr/bin/env node
// Self-contained synthetic fixture. Never proxy to any external destination.
import http from 'node:http';
import fs from 'node:fs';
const directory=process.argv[2];if(!directory)throw new Error('output directory required');
fs.mkdirSync(directory,{recursive:true,mode:0o700});
let settings={charset:'UTF-8',contact:{name:'Synthetic operator'},enabled:false};
const server=http.createServer(async(req,res)=>{
 const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks).toString();
 fs.appendFileSync(directory+'/requests.jsonl',JSON.stringify({at:Date.now(),method:req.method,url:req.url,body})+'\n',{mode:0o600});
 const u=new URL(req.url,'http://127.0.0.1');const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 if(u.pathname==='/openapi.json')return send(200,{openapi:'3.0.0',info:{title:'local108 synthetic fixture',version:'1'},paths:{'/read':{get:{}},'/compute':{post:{}},'/settings':{get:{},put:{}},'/delete-item':{delete:{}}}});
 if(u.pathname==='/settings') {if(req.method==='GET')return send(200,settings);if(req.method==='PUT'){try{settings=JSON.parse(body);return send(200,{updated:true});}catch{return send(400,{error:'json'});}}}
 if(u.pathname==='/compute'&&req.method==='POST')return send(200,{result:2,sideEffects:false});
 if(u.pathname==='/read'||u.pathname==='/')return send(200,{fixture:true,secret:'SYNTHETIC-RECORD-NOT-REAL',description:'Public synthetic response for finding pipeline tests only'});
 if(u.pathname==='/delete-item')return send(200,{deleted:true,fixture:true});
 send(404,{error:'synthetic-not-found'});
});
server.listen(0,'127.0.0.1',()=>{fs.writeFileSync(directory+'/port',String(server.address().port));console.log(server.address().port);});
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
