'use client';
import { useId } from 'react';
import { ChipSelect } from './ChipSelect';
import { type ComponentState, stateProps } from './shared';
export type ApprovalMode = 'ask' | 'allow' | 'never';
export function Matrix({
  agents,
  actions,
  values,
  onChange,
  disabled,
  loading,
}: ComponentState & {
  agents: { id: string; name: string }[];
  actions: { id: string; name: string }[];
  values: Record<string, Record<string, ApprovalMode>>;
  onChange: (agent: string, action: string, mode: ApprovalMode) => void;
}) {
  const id = useId();
  const control = (
    agent: (typeof agents)[number],
    action: (typeof actions)[number],
    layout: string,
  ) => (
    <ChipSelect
      id={`${id}-${layout}-${agent.id}-${action.id}`}
      label={`${agent.name}: ${action.name}`}
      value={values[agent.id]?.[action.id] || 'ask'}
      disabled={disabled || loading}
      onChange={(value) => onChange(agent.id, action.id, value as ApprovalMode)}
      options={[
        { value: 'ask', label: 'Ask me' },
        { value: 'allow', label: 'Allow' },
        { value: 'never', label: 'Never' },
      ]}
    />
  );
  return (
    <div {...stateProps({ disabled, loading })}>
      <div className="dl-group dl-matrix-table">
        <table className="dl-table">
          <caption className="dl-sr">Agent approvals</caption>
          <thead>
            <tr>
              <th scope="col">Action</th>
              {agents.map((agent) => (
                <th scope="col" key={agent.id}>
                  {agent.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {actions.map((action) => (
              <tr key={action.id}>
                <th scope="row">{action.name}</th>
                {agents.map((agent) => (
                  <td key={agent.id}>{control(agent, action, 'table')}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="dl-matrix-stack">
        {agents.map((agent) => (
          <section className="dl-group" key={agent.id}>
            <h3 className="dl-group-head">{agent.name}</h3>
            {actions.map((action) => (
              <div className="dl-item" key={action.id}>
                <label className="dl-t" htmlFor={`${id}-stack-${agent.id}-${action.id}`}>
                  {action.name}
                </label>
                {control(agent, action, 'stack')}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
