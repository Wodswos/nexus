/** Runs inside the selected Workspace. Never imports the SDK in the Nexus process. */
export const CLAUDE_BRIDGE = String.raw`
const {createInterface}=require('node:readline');
const {randomUUID}=require('node:crypto');
const {createRequire}=require('node:module');
const {pathToFileURL}=require('node:url');
const localRequire=createRequire(process.cwd()+'/package.json');
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
let sdk,sessionId='',directory=process.cwd(),resuming=false,runtime,sequence=0,messageId='',cancelled=false;
const pending=new Map();
async function request(method,params){const id='sdk-'+(++sequence);return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});send({id,method,params});});}
function update(value){send({method:'session/update',params:{sessionId,update:value}});}
async function handle(message){
 if(!message.method){const p=pending.get(message.id);if(p){pending.delete(message.id);message.error?p.reject(new Error(message.error.message)):p.resolve(message.result);}return;}
 const {id,method,params:p={}}=message;
 try{
  let result={};
  if(method==='initialize'){
   let path;try{path=localRequire.resolve('@anthropic-ai/claude-agent-sdk');}catch{path=require.resolve('@anthropic-ai/claude-agent-sdk',{paths:[require('node:path').join(require('node:path').dirname(process.execPath),'..','lib'),'/usr/local/lib','/usr/lib']});}
   sdk=await import(pathToFileURL(path).href);
   result={protocolVersion:1,agentCapabilities:{loadSession:true}};
  }else if(method==='session/new'||method==='session/load'){
   sessionId=p.sessionId||randomUUID();directory=p.cwd;resuming=method==='session/load';result={sessionId};
  }else if(method==='session/cancel'){cancelled=true;await runtime?.interrupt();return;}
  else if(method==='session/prompt'){
   if(runtime)throw new Error('会话正在执行');
   const options={cwd:directory,...(resuming?{resume:sessionId}:{sessionId}),includePartialMessages:true,permissionMode:'default',...(process.env.NEXUS_AGENT_MODEL?{model:process.env.NEXUS_AGENT_MODEL}:{}),
    canUseTool:async(name,input)=>{
     if(name==='AskUserQuestion'){
      const reply=await request('nexus/question',{sessionId,questions:input.questions.map((q,i)=>({...q,id:String(i)}))});
      return {behavior:'allow',updatedInput:{...input,answers:Object.fromEntries(input.questions.map((q,i)=>[q.question,(reply.answers?.[String(i)]?.answers??[]).join(', ')]))}};
     }
     const reply=await request('session/request_permission',{sessionId,toolCall:{title:name,input},options:[{optionId:'allow',name:'允许一次',kind:'allow_once'},{optionId:'deny',name:'拒绝',kind:'reject_once'}]});
     return reply?.outcome?.optionId==='allow'?{behavior:'allow',updatedInput:input}:{behavior:'deny',message:'用户拒绝授权'};
    }};
   cancelled=false;
   runtime=sdk.query({prompt:p.prompt.map(x=>x.text||'').join('\n'),options});
   let stopReason='end_turn';
   try{for await(const message of runtime){
    if(message.type==='stream_event'){
     const e=message.event;
     if(e.type==='message_start')messageId=e.message?.id||randomUUID();
     if(e.type==='content_block_delta'&&e.delta?.type==='text_delta')update({sessionUpdate:'agent_message_chunk',messageId:(messageId||'stream')+':'+(e.index||0),content:{type:'text',text:e.delta.text}});
    }else if(message.type==='assistant'){
     for(const [i,item] of (message.message?.content??[]).entries())if(item.type==='text')update({sessionUpdate:'agent_message_chunk',messageId:(message.message.id||messageId||'stream')+':'+i,complete:true,content:{type:'text',text:item.text}});
     for(const item of message.message?.content??[])if(item.type==='tool_use')update({sessionUpdate:'tool_call',toolCallId:item.id,title:item.name,status:'in_progress',rawInput:item.input});
    }else if(message.type==='user'){
     for(const item of message.message?.content??[])if(item.type==='tool_result')update({sessionUpdate:'tool_call_update',toolCallId:item.tool_use_id,status:item.is_error?'failed':'completed',rawOutput:item.content});
    }else if(message.type==='result'){if(message.is_error&&!cancelled)throw new Error((message.errors||[message.subtype]).join('\n'));}
   }}finally{runtime=undefined;resuming=true;}
   result={stopReason:cancelled?'cancelled':stopReason};
  }else throw new Error('不支持的方法 '+method);
  if(id!==undefined)send({id,result});
 }catch(error){if(id!==undefined)send({id,error:{code:-32000,message:error.message}});}
}
createInterface({input:process.stdin}).on('line',line=>{try{void handle(JSON.parse(line));}catch{process.exitCode=1;}});
`;
