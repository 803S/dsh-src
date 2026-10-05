// Read-only validation of the complete copy plan before the first mutation.
// This catches predictable path failures, not runtime I/O faults or live-reader
// atomicity; callers still need a controlled release/restart procedure.
import {existsSync,statSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
export function preflightCopyPlan({copies,requiredDirectories=[]}){
 const errors=[],destinations=new Map();
 for(const directory of requiredDirectories){
  try{if(!statSync(directory).isDirectory())errors.push('Not a directory: '+directory);}
  catch{errors.push('Missing required directory: '+directory);}
 }
 for(const {src,dest} of copies){
  try{if(!statSync(src).isFile())errors.push('Source is not a file: '+src);}
  catch{errors.push('Missing source: '+src);}
  const source=resolve(src),destination=resolve(dest);
  if(source===destination)errors.push('Source and destination are identical: '+src);
  const previous=destinations.get(destination);
  if(previous&&previous!==source)errors.push('Conflicting destination: '+dest);
  destinations.set(destination,source);
  try{
   if(existsSync(dest)&&!statSync(dest).isFile())errors.push('Destination is not a file: '+dest);
   let parent=dirname(destination);
   while(!existsSync(parent)&&dirname(parent)!==parent)parent=dirname(parent);
   if(!statSync(parent).isDirectory())errors.push('Destination parent is not a directory: '+parent);
  }catch{errors.push('Destination cannot be inspected: '+dest);}
 }
 if(errors.length)throw new Error('Deployment preflight failed:\n'+errors.join('\n'));
 return {files:copies.length,destinations:destinations.size};
}
