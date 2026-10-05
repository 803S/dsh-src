// Standalone child entry. The host must launch this through the guarded native
// provider; proxy settings alone are NOT a security boundary.
const {createConnection}=require(process.argv[2]);
const readline=require('node:readline');
async function main(){
 const server=await createConnection({browser:{browserName:'chromium',isolated:true,launchOptions:{executablePath:process.argv[3],headless:true,args:['--single-process','--no-zygote'],proxy:{server:process.env.HTTPS_PROXY,bypass:'<-loopback>'}},contextOptions:{ignoreHTTPSErrors:true,serviceWorkers:'block'}},outputDir:process.argv[4]});
 // TLS here terminates at the forced proxy, which independently verifies the
 // target certificate. The OS prevents this process connecting to targets.
 const input=readline.createInterface({input:process.stdin});
 const transport={async start(){},async close(){input.close();transport.onclose?.();},send(message){return new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(message)+'\n',error=>error?reject(error):resolve()));}};
 await server.connect(transport);
 input.on('line',line=>{try{if(Buffer.byteLength(line)>256*1024)throw new Error('MCP input limit');transport.onmessage(JSON.parse(line));}catch(error){console.error(String(error));process.exitCode=1;void server.close();}});
 input.on('close',()=>{void server.close();});
}
main().catch(error=>{console.error(String(error));process.exitCode=1;});
