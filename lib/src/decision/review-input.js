// 审核输入与展示摘要分离：不截断、不丢弃重复JSON键；凭据值仍脱敏。
import {sanitizeEvidence} from '../evidence-output.js';
const sensitive=/^(?:password|passwd|pwd|token|access[_-]?token|refresh[_-]?token|secret|authorization|cookie|api[_-]?key|credential)$/i;
export function reviewBody(input, secrets=[]) {
  const bytes=Buffer.isBuffer(input)?input:Buffer.from(input??'');
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
  if(bytes.length>65536)throw new Error('REVIEW_BODY_LIMIT');
  let result=text;
  try {
    JSON.parse(text); // 非JSON保持原语法；JSON只替换敏感值的字节区间。
    const tokens=[...text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g)], ranges=[];
    for(let i=0;i<tokens.length-2;i++) {
      if(tokens[i][0][0]!== '"'||tokens[i+1][0]!==':'||!sensitive.test(JSON.parse(tokens[i][0])))continue;
      const start=i+2;let end=start;
      if(['{','['].includes(tokens[start][0])) {
        let depth=0;
        for(;end<tokens.length;end++) {const v=tokens[end][0];if(v==='{'||v==='[')depth++;if(v==='}'||v===']')depth--;if(depth===0)break;}
      }
      ranges.push([tokens[start].index,tokens[end].index+tokens[end][0].length]);i=end;
    }
    for(const [start,end] of ranges.reverse())result=result.slice(0,start)+'"<stored>"'+result.slice(end);
  } catch {
    result=text.replace(/(^|[&\s])((?:password|passwd|pwd|token|access_token|refresh_token|secret|authorization|cookie|api[_-]?key)=)[^&\s]*/gi,'$1$2<stored>');
  }
  return sanitizeEvidence(result,secrets);
}
