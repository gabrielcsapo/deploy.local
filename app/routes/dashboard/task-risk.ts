export type RiskComputer = {
  id: string;
  online: boolean;
  workerIds: string[];
  roles: Record<string, { state: string } | undefined>;
};
export type RiskPermission = { id: string; state: string };
export function taskRisks(computer?: RiskComputer, permissions: RiskPermission[] = []) {
  if (!computer?.online) return [];
  const risks = [];
  if (computer.roles.deploy?.state === 'ready')
    risks.push({
      id: 'deploy',
      label: 'Can deploy',
      icon: 'deploy' as const,
      explanation: 'The agent can deploy applications on this computer.',
    });
  if (
    computer.roles.computer?.state === 'ready' &&
    permissions.some((p) => p.id === 'input' && p.state === 'on')
  )
    risks.push({
      id: 'screen',
      label: 'Screen access',
      icon: 'computer' as const,
      explanation:
        'With your approval, the agent can view the screen and click or type on this computer.',
    });
  return risks;
}
