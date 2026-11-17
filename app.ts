// Wiring: builds the in-memory forge and the HTTP server around it.
// Everything stateful lives in the Forge; this module only connects the pieces.

import { Forge } from './lib/store.mjs';
import { createServer } from './lib/server.mjs';

export interface ForgeOptions {
  token: string;
  trialNowSec: number;
}

export function createForge(opts: ForgeOptions) {
  const forge = new Forge({ trialNowSec: opts.trialNowSec });
  const server = createServer(forge, opts.token);
  return { forge, server };
}
