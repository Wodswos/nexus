import { createInterface } from 'node:readline';
const mode = process.env.FIXTURE_MODE || 'normal';
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const result = (id, value) => send({ id, result: value });
const update = (value) => send({ method: 'session/update', params: { sessionId: 'fixture-session', update: value } });
let prompt;
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    if (mode === 'malformed') { process.stdout.write('this is not ACP\n'); continue; }
    result(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: mode !== 'no-resume' } });
  } else if (message.method === 'session/new' || message.method === 'session/load') result(message.id, { sessionId: 'fixture-session' });
  else if (message.method === 'session/prompt') {
    prompt = message;
    if (mode === 'disconnect') { process.exit(1); }
    if (mode === 'permission') {
      send({ id: 'permission-rpc', method: 'session/request_permission', params: { sessionId: 'fixture-session', toolCall: { title: '执行测试', toolCallId: 'tool-1' }, options: [{ optionId: 'allow', name: '允许一次', kind: 'allow_once' }, { optionId: 'deny', name: '拒绝', kind: 'reject_once' }] } });
    } else if (mode === 'question') {
      send({ id: 'permission-rpc', method: 'nexus/question', params: { sessionId: 'fixture-session', questions: [{ id: 'scope', question: '先支持哪些端？', multiSelect: true, options: [{ label: '桌面端', description: '键鼠' }, { label: '手机端', description: '触屏' }] }] } });
    } else if (mode === 'slow') { /* cancellation or process termination completes this turn */ }
    else {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已处理：' } });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: message.params.prompt[0].text } });
      update({ sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: '验证', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: process.env.NEXUS_AGENT_TOKEN } }] });
      result(message.id, { stopReason: 'end_turn' });
    }
  } else if (message.id === 'permission-rpc') {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(message.result) } });
    result(prompt.id, { stopReason: 'end_turn' });
  } else if (message.method === 'session/cancel' && prompt) result(prompt.id, { stopReason: 'cancelled' });
}
