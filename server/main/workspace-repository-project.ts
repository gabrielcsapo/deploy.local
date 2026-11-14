import { createRepositoryProject } from '../v2/projects.ts';
import { registerRepositoryProjectCreator } from '../workspace/repository-project-port.ts';

export function wireRepositoryProjectCreator() {
  registerRepositoryProjectCreator(createRepositoryProject);
}
