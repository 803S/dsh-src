import {useState} from 'react'
type RunCommand=(command:string)=>Promise<{kind:string;text:string}>
export function EgressControls({runCommand}:{runCommand?:RunCommand}) {
  const [origins,setOrigins]=useState('')
  const [approval,setApproval]=useState('')
  const [disposition,setDisposition]=useState('cancel-never-sent')
  const [evidence,setEvidence]=useState('')
  const [result,setResult]=useState('')
  const [busy,setBusy]=useState(false)
  const run=async(command:string)=>{if(!runCommand||busy)return;setBusy(true);try{const r=await runCommand(command);setResult(`${r.kind}: ${r.text}`)}catch(e){setResult(String(e))}finally{setBusy(false)}}
  return <details><summary>目标出口范围与审批核对</summary>
    <p>范围必须由你确认；登记资产不自动扩大出口权限。每行填写一个精确 origin（协议、域名、端口），更改后旧任务失效。</p>
    <textarea aria-label="目标 origins" value={origins} onChange={e=>setOrigins(e.target.value)} placeholder={'https://example.com\nhttps://api.example.com:8443'} rows={3}/>
    <button disabled={busy||!runCommand||!origins.trim()} onClick={()=>void run(`/src-egress-scope ${JSON.stringify(origins.split(/\s+/).filter(Boolean))}`)}>确认并替换范围</button>
    <button disabled={busy||!runCommand} onClick={()=>void run('/src-egress-status')}>查看当前范围和状态</button>
    <hr/>
    <input aria-label="审批编号" placeholder="approval-1" value={approval} onChange={e=>setApproval(e.target.value)}/>
    <button disabled={busy||!runCommand||!/^approval-\d+$/.test(approval)} onClick={()=>void run(`/src-egress-review ${approval}`)}>查看完整脱敏计划</button>
    <p>下方操作不批准、不发送、不自动重试。只有你已核对目标实际状态，才解除旧锁；后续仍需重新人工审批。</p>
    <select aria-label="核对结论" value={disposition} onChange={e=>setDisposition(e.target.value)}>
      <option value="cancel-never-sent">确认未发送，撤销待审</option><option value="confirmed-not-applied">已核对：变更未生效</option><option value="confirmed-applied">已核对：变更已生效</option><option value="withdraw-rejection">撤回此前拒绝，重新审核</option>
    </select>
    <textarea aria-label="核对依据" value={evidence} onChange={e=>setEvidence(e.target.value)} placeholder="至少20字：核对了什么对象、证据在哪里、实际结果是什么" rows={3}/>
    <button disabled={busy||!runCommand||!/^approval-\d+$/.test(approval)||evidence.trim().length<20} onClick={()=>void run(`/src-egress-reconcile ${approval} ${disposition} ${evidence.replace(/\s+/g,' ')}`)}>记录核对，解除旧锁</button>
    {result&&<pre role="status" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',maxHeight:320,overflow:'auto'}}>{result}</pre>}
  </details>
}
