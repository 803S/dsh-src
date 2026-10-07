import {domainGrant} from './user-scope.js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { gateError } from './plan.js';

export function isPublicAddress(address) {
  const family=isIP(address);
  if(family===6){
    const normalized=new URL(`http://[${address}]/`).hostname.slice(1,-1).toLowerCase();
    if(!/^[23][0-9a-f]{3}:/.test(normalized))return false;
    const [first,second]=normalized.split(':').map(part=>parseInt(part||'0',16));
    // Exclude transition/tunnel, special-purpose and documentation prefixes,
    // including expanded spellings of Teredo/ORCHID rather than regex aliases.
    return first!==0x2002&&first!==0x3ffe&&first!==0x3fff&&!(first===0x2001&&(second<0x200||second===0xdb8));
  }
  if(family!==4)return false;
  const [a,b,c]=address.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===198&&[18,19].includes(b)||a===192&&b===0&&(c===0||c===2)||a===198&&b===51&&c===100||a===203&&b===0&&c===113);
}
export async function pinOrigin(origin,{allowLoopbackFixtures=false}={}) {
  const url=new URL(origin);
  if(url.origin!==origin||!['https:','http:'].includes(url.protocol))throw gateError('INVALID_SCOPE');
  const host=url.hostname.replace(/^\[|\]$/g,'');
  const rows=isIP(host)?[{address:host,family:isIP(host)}]:await lookup(host,{all:true,verbatim:true});
  if(!rows.length||rows.length>32||rows.some(row=>!isPublicAddress(row.address)&&!(allowLoopbackFixtures&&['127.0.0.1','::1'].includes(row.address))))throw gateError('NON_PUBLIC_TARGET');
  return [...new Map(rows.map(row=>[row.address,{address:row.address,family:row.family}])).values()];
}
export function pinnedLookup(rows) {
  return (_host,options,callback)=>{
    const family=typeof options==='number'?options:options?.family;
    const selected=rows.filter(row=>!family||row.family===family);
    if(!selected.length){callback(gateError('ADDRESS_FAMILY_NOT_PINNED'));return;}
    if(options?.all)callback(null,selected);else callback(null,selected[0].address,selected[0].family);
  };
}
export function validateStoredScope(scope,{allowLoopbackFixtures=false}={}) {
  if(!scope||typeof scope.revision!=='string'||!scope.revision||typeof scope.credentialRevision!=='string'||!scope.credentialRevision||!Array.isArray(scope.origins)||(!scope.origins.length&&!scope.domains?.length&&!scope.excludedDomains?.length)||scope.origins.length>256||!scope.pins)throw gateError('CORRUPT_SCOPES');
  if(scope.domains!==undefined&&(!Array.isArray(scope.domains)||scope.domains.length>256||scope.domains.some(d=>domainGrant(d)!==d)))throw gateError('CORRUPT_SCOPES');
  if(scope.excludedDomains!==undefined&&(!Array.isArray(scope.excludedDomains)||scope.excludedDomains.length>256||scope.excludedDomains.some(d=>domainGrant(d)!==d)))throw gateError('CORRUPT_SCOPES');
  for(const origin of scope.origins){
    const url=new URL(origin),pins=scope.pins[origin];
    if(url.origin!==origin||!['http:','https:'].includes(url.protocol)||!Array.isArray(pins)||!pins.length||pins.length>32||pins.some(row=>isIP(row.address)!==row.family||!isPublicAddress(row.address)&&!(allowLoopbackFixtures&&['127.0.0.1','::1'].includes(row.address))))throw gateError('CORRUPT_SCOPES');
  }
  return scope;
}
