import { type IncomingMessage, type ServerResponse } from 'node:http';
export interface ApiRouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  method: string | undefined;
  url: URL;
  workspacePath: string;
}
