/** The engine owns SQL, enrollment and secrets. Register its existing cached readers. */
export type ComputerRoleId = 'deploy' | 'tasks' | 'computer' | 'browser';
export type WantedRoles = Partial<Record<ComputerRoleId, boolean>>;
// Structurally compatible with shared/v2 Role; the kernel does not depend on product contracts.
export type Role = 'coordinator' | 'take-tasks' | 'run-apps' | 'serve-models' | 'use-screen';
type NodeLookup = {
  node(id: string): { id: string } | null;
  preferences(id: string): WantedRoles;
};
let lookup: NodeLookup | undefined;
const observers = new Set<() => void>();
export function configureComputerNodes(value: NodeLookup) {
  lookup = value;
  invalidateComputerNodes();
}
export function computerNodesConfigured() {
  return lookup !== undefined;
}
export function computerNode(id: string) {
  if (!lookup) throw new Error('Computer node lookup is not configured');
  return lookup.node(id);
}
export function computerPreferences(id: string) {
  if (!lookup) throw new Error('Computer node lookup is not configured');
  return lookup.preferences(id);
}
export function onNodeChange(listener: () => void) {
  observers.add(listener);
}
export function invalidateComputerNodes() {
  for (const listener of observers) listener();
}
