import { type IncomingMessage, type ServerResponse } from 'node:http';
import { type legacyUpdateService } from '../legacy-update-service.ts';
import {
  type wanderAdoptionService,
  type wanderAdoptionPreflight,
} from '../wander-adoption-service.ts';

export interface ApiRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  method: string | undefined;
  url: URL;
  workspacePath: string;
  makeLegacyUpdate: typeof legacyUpdateService;
  makeWanderAdoption: typeof wanderAdoptionService;
  wanderPreflight: typeof wanderAdoptionPreflight;
}
