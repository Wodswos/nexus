import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const emit=value=>process.stdout.write(JSON.stringify(value)+'\n');
const note=(method,params)=>emit({method,params});
const thread='thread-fixture';let turns=0,active,approval;
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);const reply=result=>emit({id:m.id,result});
 if(m.method==='initialize')reply({userAgent:'fixture/1'});
 else if(m.method==='thread/start'||m.method==='thread/resume')reply({thread:{id:thread,turns:[]}});
 else if(m.method==='turn/start'){
  const id=`turn-${++turns}`,itemId=`message-${turns}`,text=m.params.input[0].text;active=id;
  if(process.env.FIXTURE_RECEIPTS)appendFileSync(process.env.FIXTURE_RECEIPTS,text+'\n');
  reply({turn:{id,status:'inProgress'}});
  note('item/started',{threadId:thread,turnId:id,item:{id:itemId,type:'agentMessage',text:''}});
  note('item/agentMessage/delta',{threadId:thread,turnId:id,itemId,delta:'正在处理中文 '});
  const finish=()=>{note('item/completed',{threadId:thread,turnId:id,item:{id:itemId,type:'agentMessage',text:'正在处理中文 '+text}});note('turn/completed',{threadId:thread,turn:{id,status:'completed'}});};
  if(text==='approval'){approval=finish;emit({id:'permission-1',method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:id,itemId:'command-1',command:'pnpm test',reason:'运行测试',availableDecisions:['accept','decline']}});}
  else setTimeout(finish,text==='slow'?500:30);
 }else if(m.method==='turn/interrupt'){reply({});note('turn/completed',{threadId:thread,turn:{id:active,status:'interrupted'}});}
 else if(m.id==='permission-1'){approval?.();}
});

if(process.env.FIXTURE_KEEP_ALIVE)setInterval(()=>{},1000);
