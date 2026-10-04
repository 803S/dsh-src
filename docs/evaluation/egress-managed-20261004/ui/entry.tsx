import React from 'react'
import {createRoot} from 'react-dom/client'
import {EgressControls} from './src/client/EgressControls'
const commands:string[]=[];(window as any).commands=commands
createRoot(document.getElementById('root')!).render(<EgressControls runCommand={async command=>{commands.push(command);return {kind:'success',text:'本机 UI 测试：命令已捕获，未发送目标请求。'}}}/>);
