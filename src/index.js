// amazon-connect-mcp - an MCP server (streamable HTTP, stateless) for
// Amazon Connect, running on Cloudflare Workers with zero dependencies.

import { ConnectClient, ConnectError } from './connect.js';
import { toolDefs, callTool } from './tools.js';
import { handleOAuth, checkAuth, unauthorized } from './oauth.js';
import { INSTRUCTIONS } from './about.js';
import { landingPage, setupPage } from './ui.js';
import { loadConfig, saveConfig, randomToken } from './config.js';
import { REGION_RE, UUID_RE } from './rules.js';

const SERVER_INFO = { name: 'amazon-connect-mcp', version: '0.1.0' };
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Protocol-Version, Mcp-Session-Id',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    const res = await route(request, env);
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
    return res;
  },
};

async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method === 'OPTIONS') return new Response(null, { status: 204 });

  const cfg = await loadConfig(env);

  const oauthRes = await handleOAuth(request, cfg.authToken, url);
  if (oauthRes) return oauthRes;

  if (request.method === 'GET' && path === '/') return html(landingPage(toolDefs(), cfg));
  if (request.method === 'GET' && path === '/setup') return html(setupPage(cfg));
  if (request.method === 'POST' && path === '/setup') return handleSetup(request, env, cfg);
  if (request.method === 'GET' && path === '/health') return json({ ok: true, server: SERVER_INFO, configured: cfg.configured });

  if (path === '/' || path === '/mcp') {
    if (request.method !== 'POST') {
      return json({ error: 'MCP requests must be POSTed to /mcp' }, 405);
    }
    if (!(await checkAuth(request, cfg.authToken))) return unauthorized(url.origin);
    let body;
    try { body = await request.json(); } catch {
      return json(rpcError(null, -32700, 'Parse error: body must be JSON'), 400);
    }
    if (Array.isArray(body)) {
      const results = (await Promise.all(body.map((m) => handleMessage(m, cfg)))).filter(Boolean);
      return results.length ? json(results) : new Response(null, { status: 202 });
    }
    const result = await handleMessage(body, cfg);
    return result ? json(result) : new Response(null, { status: 202 });
  }

  return json({ error: 'Not found' }, 404);
}

// In-browser setup wizard. First run (nothing configured) is open; once
// configured, changes require the current access key. Env-managed servers
// (Wrangler secrets) can't be edited here - secrets win over KV.
async function handleSetup(request, env, cfg) {
  if (cfg.source === 'env') {
    return json({ error: 'This server is configured with Wrangler secrets, which override the setup wizard. Update it with `npx wrangler secret put`.' }, 409);
  }
  if (!cfg.hasKv) {
    return json({ error: 'No CONFIG KV namespace is bound to this Worker - add the [[kv_namespaces]] block from wrangler.toml and redeploy.' }, 500);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Body must be JSON.' }, 400); }

  if (cfg.configured) {
    const auth = request.headers.get('Authorization') || '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (body.current_key || '');
    if (!cfg.authToken || presented !== cfg.authToken) {
      return json({ error: 'This server is already configured - enter its current access key to make changes.' }, 401);
    }
  }

  const accessKeyId = String(body.access_key_id || '').trim();
  const secretAccessKey = String(body.secret_access_key || '').trim();
  const sessionToken = String(body.session_token || '').trim();
  const region = String(body.region || 'us-east-1').trim();
  const instanceId = String(body.instance_id || '').trim().split('/').pop();
  if (!accessKeyId || !secretAccessKey) return json({ error: 'Access key ID and secret access key are required.' }, 400);
  if (!REGION_RE.test(region)) return json({ error: `"${region}" is not an AWS region (e.g. us-east-1).` }, 400);
  if (instanceId && !UUID_RE.test(instanceId)) return json({ error: 'Instance ID must be the instance UUID (or its ARN).' }, 400);

  // Validate the credentials against Connect before saving anything, and
  // discover the instance when there is exactly one.
  let instance;
  try {
    const probe = new ConnectClient({ accessKeyId, secretAccessKey, sessionToken, region, instanceId });
    const id = await probe.instanceId();
    instance = (await probe.get(`/instance/${id}`)).Instance;
  } catch (e) {
    return json({ error: `Amazon Connect rejected this setup: ${e.message}` }, 400);
  }

  const isFirstRun = !cfg.configured;
  const authToken = cfg.authToken || randomToken();
  await saveConfig(env, { accessKeyId, secretAccessKey, sessionToken, region, instanceId: instance.Id, authToken });
  return json({
    ok: true,
    instance: instance.InstanceAlias,
    instanceId: instance.Id,
    // The key is shown once, on first configuration only.
    accessKey: isFirstRun ? authToken : undefined,
    note: isFirstRun
      ? `Connected to "${instance.InstanceAlias}" (${instance.Id}, ${region}). Save this access key somewhere safe - it is shown only once. Use it to connect Claude, ChatGPT, or any MCP client.`
      : `Credentials updated (instance "${instance.InstanceAlias}"). Your existing access key is unchanged.`,
  });
}

async function handleMessage(msg, cfg) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return rpcError(msg?.id ?? null, -32600, 'Invalid JSON-RPC 2.0 request');
  }
  const { id, method, params } = msg;

  // Notifications (no id) get no response body.
  if (id === undefined || id === null) return null;

  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case 'ping':
        return rpcResult(id, {});
      case 'tools/list':
        return rpcResult(id, { tools: toolDefs() });
      case 'tools/call': {
        const name = params?.name;
        try {
          const result = await callTool(cfg, name, params?.arguments);
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          return rpcResult(id, { content: [{ type: 'text', text }], isError: false });
        } catch (e) {
          if (e instanceof ConnectError || e.message?.startsWith('Unknown tool')) {
            return rpcResult(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
          }
          throw e;
        }
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return rpcError(id, -32603, `Internal error: ${e.message}`);
  }
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function html(markup) {
  return new Response(markup, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}
