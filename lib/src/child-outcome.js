// Read only the latest completed turn. Idle alone is not successful completion.
export function childTurnFailure(session) {
  const events=session?.events;
  if(!Array.isArray(events))return undefined;
  for(let i=events.length-1;i>=0;i--){
    const event=events[i];
    if(event.type==='turn/start')return undefined;
    if(event.type==='turn/end'){
      const reason=event.data?.reason;
      if(reason?.kind!=='error')return undefined;
      return {code:String(reason.error?.code??'UNKNOWN'),message:String(reason.error?.message??'child turn failed').slice(0,600)};
    }
  }
  return undefined;
}
