// One outbound timing boundary for low-level execution tools; no new scheduler/retry.
import {reserveRequestStart} from './request-rate.js';
// 只在最终传输准备发送时启动目标超时；Jev审核和排队不消耗此预算。
export function targetDeadline(timeoutMs, signal) {
  const controller=new AbortController();let timer;
  return {signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal,
    onSend(){if(!timer)timer=setTimeout(()=>controller.abort(new DOMException('目标请求超时','AbortError')),timeoutMs);},
    close(){clearTimeout(timer);}};
}
export function boundedTransport(transport, {engagementId, intervalMs=250, signal, scopeOrigin}) {
  return async (url, init={}) => {
    const target=new URL(url);
    if(scopeOrigin) {
      const scope=new URL(scopeOrigin);
      if(target.hostname===scope.hostname && target.origin!==scope.origin) throw new Error('请求协议/端口超出已授权origin');
    }
    const combined=signal&&init.signal?AbortSignal.any([signal,init.signal]):signal??init.signal;
    combined?.throwIfAborted();
    await reserveRequestStart(`outbound:${engagementId}`,intervalMs,combined);
    combined?.throwIfAborted();
    return transport(url,{...init,redirect:'manual',...(combined?{signal:combined}:{})});
  };
}
