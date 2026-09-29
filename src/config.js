// Configuration resolution. Two sources, env wins:
//   1. Wrangler secrets / vars: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
//      AWS_SESSION_TOKEN (optional, temporary credentials), AWS_REGION,
//      CONNECT_INSTANCE_ID (optional when the region has exactly one
//      instance), MCP_AUTH_TOKEN
//   2. The KV-stored config written by the in-browser setup wizard (/setup)
//
// Use a dedicated IAM user with docs/iam-policy.json attached: it allows
// only what the tools do and explicitly DENIES deletes, go-live wiring,
// dialing, and number inventory changes, so AWS enforces the promise even
// if this code were changed.

const KV_KEY = 'connect-config';

export async function loadConfig(env) {
  let stored = null;
  if (env.CONFIG) {
    try { stored = await env.CONFIG.get(KV_KEY, 'json'); } catch { /* KV unavailable */ }
  }
  const envManaged = Boolean(env.AWS_ACCESS_KEY_ID || env.AWS_SECRET_ACCESS_KEY);
  const src = envManaged ? {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
    region: env.AWS_REGION,
    instanceId: env.CONNECT_INSTANCE_ID,
  } : (stored || {});
  const cfg = {
    accessKeyId: src.accessKeyId || '',
    secretAccessKey: src.secretAccessKey || '',
    sessionToken: src.sessionToken || '',
    region: src.region || env.AWS_REGION || 'us-east-1',
    instanceId: src.instanceId || env.CONNECT_INSTANCE_ID || '',
    authToken: env.MCP_AUTH_TOKEN || stored?.authToken || '',
    source: envManaged ? 'env' : (stored ? 'kv' : 'none'),
    hasKv: Boolean(env.CONFIG),
  };
  cfg.configured = Boolean(cfg.accessKeyId && cfg.secretAccessKey);
  return cfg;
}

export async function saveConfig(env, { accessKeyId, secretAccessKey, sessionToken, region, instanceId, authToken }) {
  await env.CONFIG.put(KV_KEY, JSON.stringify({ accessKeyId, secretAccessKey, sessionToken, region, instanceId, authToken }));
}

export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
