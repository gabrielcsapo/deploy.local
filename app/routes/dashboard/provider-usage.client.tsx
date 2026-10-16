import { WorkspaceIcon } from './workspace-icon';
import type { ProviderUsage } from '../../../server/workspace/provider-usage';

type Worker = { name: string; status: string; providers?: ProviderUsage[] };
export function ProviderUsageFooter({ worker }: { worker?: Worker }) {
  const providers = worker?.providers;
  return (
    <section className="pw-usage" aria-label="Provider usage">
      <div className="pw-usage-heading">
        <span>Usage</span>
        <span title={worker?.name}>{worker?.name || 'Computer'}</span>
      </div>
      {!providers?.length && <p className="pw-usage-note">Usage unavailable on this computer</p>}
      {providers?.map((provider) => {
        const stale =
          worker?.status !== 'online' ||
          !provider.checkedAt ||
          Date.now() / 1000 - provider.checkedAt > 120 ||
          provider.windows.some(
            (window) => window.resetsAt != null && window.resetsAt <= Date.now() / 1000,
          );
        const highest = provider.windows.reduce((max, w) => Math.max(max, w.usedPercent), 0);
        const status =
          provider.status === 'loading'
            ? 'Checking…'
            : provider.status === 'signed-out'
              ? 'Sign in required'
              : provider.status === 'unavailable'
                ? 'Unavailable'
                : provider.windows.length
                  ? `${Math.round(highest)}% used${stale ? ' · stale' : ''}`
                  : 'Usage unavailable';
        return (
          <details className="pw-usage-provider" key={provider.id}>
            <summary>
              <span className="pw-usage-row">
                <span>{provider.name}</span>
                <span className="pw-usage-status">{status}</span>
                <WorkspaceIcon name="chevron-down" className="pw-usage-chevron" />
              </span>
              {provider.windows.length > 0 && (
                <meter
                  min={0}
                  max={100}
                  value={highest}
                  aria-label={`${provider.name} most used allowance`}
                />
              )}
            </summary>
            <div className="pw-usage-details">
              {provider.status === 'signed-in' && (
                <p>
                  {provider.plan
                    ? `${provider.plan.charAt(0).toUpperCase()}${provider.plan.slice(1)} account`
                    : 'Signed in'}
                </p>
              )}
              {provider.windows.map((window) => (
                <div className="pw-usage-window" key={window.id}>
                  <div>
                    <span>{window.label}</span>
                    <span>{Math.round(window.usedPercent)}% used</span>
                  </div>
                  <p>{Math.round(100 - window.usedPercent)}% remaining</p>
                  <p>
                    {window.resetsAt
                      ? `${window.resetsAt * 1000 <= Date.now() ? 'Reset due' : 'Resets'} ${new Date(window.resetsAt * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                      : 'Reset time unavailable'}
                  </p>
                </div>
              ))}
              {provider.status === 'signed-out' && (
                <p>
                  Sign in with {provider.name === 'Codex' ? 'codex login' : 'claude auth login'} on
                  this computer.
                </p>
              )}
              {provider.status === 'signed-in' && !provider.windows.length && (
                <p>The provider has not reported account limits through this connection.</p>
              )}
              {provider.status === 'unavailable' && (
                <p>Could not read the provider account. Check its CLI on this computer.</p>
              )}
              {provider.checkedAt && (
                <p>
                  {stale ? 'Last checked' : 'Updated'}{' '}
                  {new Date(provider.checkedAt * 1000).toLocaleTimeString([], {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                  . {stale ? 'Waiting for fresh usage.' : 'Refreshes every minute.'}
                </p>
              )}
              {worker?.status !== 'online' && <p>Computer offline</p>}
            </div>
          </details>
        );
      })}
    </section>
  );
}
