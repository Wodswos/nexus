import React from 'react';
import { SelectField } from '@nexus/ui';
import type { AgentRoundInput } from '@nexus/core';
export const roundKinds = { auto: 'Agent 自主判断', clarify: '澄清范围', design: '设计方案', explore: '探索验证', implement: '实现', deliver: '交付' } as const;
export const emptyRound = (): AgentRoundInput => ({ kind: 'auto', objective: '', expectedOutcome: '', acceptanceCriteria: [] });
const field = 'w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-xs leading-6 outline-none focus:border-[var(--accent-solid)]';
export function AgentRoundEditor({ value, onChange, disabled }: { value: AgentRoundInput; onChange: (value: AgentRoundInput) => void; disabled?: boolean }) {
  return <fieldset disabled={disabled} className="space-y-3 rounded-xl border border-[var(--border)] p-3"><legend className="px-1 text-xs font-medium">本轮工作</legend>
    <SelectField aria-label="本轮类型" value={value.kind} disabled={disabled} onValueChange={(kind) => onChange({ ...value, kind: kind as AgentRoundInput['kind'] })} options={Object.entries(roundKinds).map(([key, label]) => ({ value: key, label }))} className="w-full" />
    <label className="block space-y-1 text-xs"><span>本轮目标</span><textarea aria-label="本轮目标" rows={2} value={value.objective} onChange={(event) => onChange({ ...value, objective: event.target.value })} placeholder="这一次需要 Agent 推进什么？" maxLength={4000} required className={field} /></label>
    <label className="block space-y-1 text-xs"><span>预期产物</span><input aria-label="预期产物" value={value.expectedOutcome} onChange={(event) => onChange({ ...value, expectedOutcome: event.target.value })} placeholder="例如：一份方案、可运行的实现、验证结论" maxLength={4000} required className={field} /></label>
    <label className="block space-y-1 text-xs"><span>验收条件 · 每行一条</span><textarea aria-label="验收条件" rows={2} value={value.acceptanceCriteria.join('\n')} onChange={(event) => onChange({ ...value, acceptanceCriteria: event.target.value.split('\n') })} maxLength={8000} className={field} /></label>
  </fieldset>;
}
