// Entrypoint. The trial runs `node /bot/main.ts`: bind an ephemeral port,
// register it with the environment, answer health checks, and exit 0 once the
// environment reports done. Without MAKEFUN_ENV_URL the forge runs standalone
// and prints its port, which is how local smoke tests drive it.

import { createForge } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL || '').replace(/\/$/, '');
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN || '';
const TRIAL_NOW = Number(process.env.MAKEFUN_TRIAL_NOW || '') || 1735689600;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, payload: unknown): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return res.status;
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status !== 200) return null;
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const { server } = createForge({ token: TOKEN, trialNowSec: TRIAL_NOW });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const addr = server.address();
      resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
    });
  });
  console.log(`forge listening on ${port}`);

  if (!ENV_URL) {
    console.log('MAKEFUN_ENV_URL is not set; running standalone');
    return;
  }

  let registered = false;
  for (let attempt = 0; attempt < 120 && !registered; attempt++) {
    try {
      const status = await postJson(`${ENV_URL}/register`, { port });
      if (status === 200 || status === 409) registered = true;
    } catch {
      // The environment may not be up yet; retry.
    }
    if (!registered) await sleep(500);
  }
  if (!registered) {
    console.error('could not register with the environment');
    process.exit(1);
  }

  let delay = 250;
  for (;;) {
    let done = false;
    try {
      const data = await getJson(`${ENV_URL}/done`);
      if (data && typeof data === 'object' && (data as { done?: unknown }).done === true) done = true;
    } catch {
      // Transient failure; keep polling.
    }
    if (done) break;
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
