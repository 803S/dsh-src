// Native DSH feasibility probe, not a production browser adapter. Keep the
// existing OS restrictions intact and use only a runner-owned loopback page.
export async function browserStartProbe({call,origin,log}){
 const result=await call('bash',{command:`node fixture-browser.cjs '${origin}/browser.html'`,description:'Check installed Playwright browser startup inside the existing DSH egress sandbox'});
 log({type:'browser-start-feasibility',exitCode:result.exitCode,stdout:result.stdout?.text,stderr:result.stderr?.text});
 if(result.exitCode!==0||!result.stdout?.text.includes('synthetic-browser'))throw new Error('Existing browser startup requirements not met inside enforced DSH sandbox');
}
