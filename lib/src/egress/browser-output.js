// Preserve the native MCP value; admit images through DSH's durable store,
// never raw inline base64, remote fetches, or model capability guesses.
import {isDeepStrictEqual} from 'node:util';
export function browserProjectionDecision(projection,exec,result,decision){
 if(!projection||result.isError||exec.signal?.aborted||decision.kind!=='accept'||Object.hasOwn(decision,'content')||Object.hasOwn(decision,'value')||!isDeepStrictEqual(result.value,projection.value))return decision;
 return {...decision,content:projection.content};
}
export async function projectBrowserOutput(ctx,exec,content){
 if(!Array.isArray(content))throw new Error('Invalid MCP content');
 const images=content.filter(block=>block?.type==='image');let refs=[],unavailable,phase='image validation failed';
 if(images.length){
  try{
   const decoded=images.map(block=>{
    if(!['image/png','image/jpeg','image/webp','image/gif'].includes(block.mimeType)||typeof block.data!=='string')throw new Error('invalid image');
    const data=Buffer.from(block.data,'base64');if(!data.length||data.toString('base64')!==block.data)throw new Error('invalid image');
    return {data,mediaType:block.mimeType};
   });
   const attachments=ctx.get('attachments'),llm=ctx.get('llm');
   phase='image store or model route unavailable';
   const route=exec.agent.session.requestHeader?.()?.config;
   const provider=route?.provider??exec.agent.options?.provider,model=route?.model??exec.agent.options?.model;
   if(!attachments||!llm||!provider||!model)throw new Error('image route unavailable');
   const info=await llm.resolveModelInfo(provider,model,exec.signal);
   phase='current model does not declare image input';
   if(!info.inputModalities?.includes('image'))throw new Error('model does not support images');
   phase='durable image storage or cancellation rejected result';
   exec.signal?.throwIfAborted();refs=await attachments.saveImages(decoded);
   if(refs.length!==images.length)throw new Error('image storage incomplete');
  }catch{unavailable=`[image unavailable: ${phase}; raw data retained in MCP value]`;}
 }
 let imageIndex=0;
 return content.map(block=>{
  if(block?.type==='text'&&typeof block.text==='string')return {type:'text',text:block.text};
  if(block?.type==='image'){const ref=refs[imageIndex++];return unavailable?{type:'text',text:unavailable}:{type:'image',attachment:ref};}
  return {type:'text',text:`[MCP ${String(block?.type??'unknown')} content retained in tool value; not fetched or executed]`};
 });
}
