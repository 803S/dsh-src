// Deterministic, isolated research benchmark helpers. This is not a vulnerability oracle:
// it checks that a sourced advisory and explicit version predicates can become a bounded,
// falsifiable research hypothesis with positive and negative controls.
const VERSION_RE = /\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?/g;
function parts(version) {
 const raw=String(version ?? '').trim().replace(/^v/i,'');
 if(/^\d+(?:\.\d+)*(?:[-+].*)?$/.test(raw)) return raw.split(/[.+-]/).filter(Boolean).map(x=>/^\d+$/.test(x)?Number(x):x.toLowerCase());
 return raw.match(VERSION_RE)?.[0].split(/[.+-]/).filter(Boolean).map(x=>/^\d+$/.test(x)?Number(x):x.toLowerCase()) ?? [];
}
export function compareVersions(left,right) {
 const a=parts(left),b=parts(right);if(!a.length||!b.length)throw new Error('版本号无法解析');
 for(let i=0;i<Math.max(a.length,b.length);i++){const x=a[i]??0,y=b[i]??0;if(x===y)continue;if(typeof x==='number'&&typeof y==='number')return x<y?-1:1;return String(x).localeCompare(String(y),'en',{numeric:true});}return 0;
}
export function evaluateVersionRange(version,{introduced='0',fixed}) {
 if(!fixed)throw new Error('缺少公告中的修复版本，不能判断影响范围');
 return {version:String(version),fixed:String(fixed),affected:compareVersions(version,introduced)>=0&&compareVersions(version,fixed)<0,reason:compareVersions(version,introduced)<0?'below-introduced':compareVersions(version,fixed)>=0?'at-or-above-fixed':'within-affected-range'};
}
export function buildResearchBenchmarkCase({sourceUrl,advisoryId,product,affectedVersion,fixedVersion,negativeVersion,preconditions=[]}) {
 const u=new URL(sourceUrl);if(u.protocol!=='https:')throw new Error('基准公告来源必须为 HTTPS');
 if(!/^CVE-\d{4}-\d{3,}$/.test(advisoryId))throw new Error('advisoryId 必须是 CVE 标识');
 const positive=evaluateVersionRange(affectedVersion,{fixed:fixedVersion}),negative=evaluateVersionRange(negativeVersion,{fixed:fixedVersion});
 if(!positive.affected||negative.affected)throw new Error('正/负版本对照不成立：需一个受影响版本和一个已修复版本');
 return {advisory:{id:advisoryId,product,sourceUrl:u.href},positive,negative,preconditions:preconditions.map(String).slice(0,20),createsFinding:false,networkRequests:0};
}
