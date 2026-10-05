import {gateError} from './plan.js';
// Audited Burp history/status methods only. These read the owner's existing
// proxy log; they do not replay requests, modify interception or start scans.
// The installed MCP transport/backend remains trusted owner configuration.
const history=new Set(['get_proxy_http_history','get_proxy_http_history_regex','get_proxy_websocket_history','get_proxy_websocket_history_regex'].map(name=>'mcp__burp__'+name));
export const isBurpPassiveTool=name=>history.has(name)||name==='mcp__burp__burp_status';
export function passiveBurpArguments(name,args){
 if(!isBurpPassiveTool(name))throw gateError('UNADAPTED_TOOL');
 if(!args||typeof args!=='object'||Array.isArray(args))throw gateError('INVALID_BURP_HISTORY_ARGUMENTS');
 const status=name==='mcp__burp__burp_status',regex=name.endsWith('_regex');
 const keys=status?[]:regex?['count','offset','regex']:['count','offset'];
 if(Object.keys(args).some(key=>!keys.includes(key)))throw gateError('INVALID_BURP_HISTORY_ARGUMENTS');
 if(status)return args;
 const count=args.count??10,offset=args.offset??0;
 if(!Number.isSafeInteger(count)||count<1||count>100||!Number.isSafeInteger(offset)||offset<0||offset>1000000)throw gateError('INVALID_BURP_HISTORY_PAGE');
 if(regex&&(typeof args.regex!=='string'||args.regex.length===0||args.regex.length>512||args.regex.includes('\0')))throw gateError('INVALID_BURP_HISTORY_REGEX');
 return Object.freeze({count,offset,...(regex?{regex:args.regex}:{})});
}
