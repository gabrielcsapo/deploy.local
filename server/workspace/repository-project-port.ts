import type { RepositoryProjectCreator } from '../contracts/repository-project.ts';

let provider: RepositoryProjectCreator | undefined;

export function registerRepositoryProjectCreator(value: RepositoryProjectCreator) {
  provider = value;
}

export function requireRepositoryProjectCreator(processName: string): RepositoryProjectCreator {
  if (!provider) throw new Error(`RepositoryProjectCreator is not wired in ${processName}`);
  return provider;
}
