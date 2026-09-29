// Pure safety rails. No I/O here, so everything that decides "is this
// request allowed / what gets sent" is unit tested in test/rules.test.js.
//
// The pattern is normalize-then-ALLOWLIST (ported from ringcx-mcp):
//   1. refuse anything a URL parser or the service could read differently
//      than we do: %, ;, \, #, ?, whitespace, empty or dot segments,
//   2. query keys are plain identifiers, unique case-insensitively, with
//      scalar values,
//   3. the (service, method, path) must match an allowlisted operation
//      template, and the host is never caller-controlled: it is built from
//      the service name and a validated region,
//   4. everything else is refused, with a precise, polite reason for the
//      families that are refused on purpose (deletes, go-live, dialing,
//      number inventory, IAM and security profiles).
//
// ConnectClient.request() runs checkRequest() on EVERY call, typed tools
// included, so the rails are not just a raw-tool feature: no code path in
// this server can send a Delete*, AssociatePhoneNumberContactFlow,
// AssociateFlow, UpdatePhoneNumber, Start*Contact, StartCampaign,
// ResumeCampaign, ClaimPhoneNumber, or ReleasePhoneNumber. docs/iam-policy.json
// makes AWS enforce the same promise server side.

export const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const SERVICES = {
  connect: (region) => `connect.${region}.amazonaws.com`,
  'connect-campaigns': (region) => `connect-campaigns.${region}.amazonaws.com`,
};

export function hostFor(service, region) {
  if (!SERVICES[service]) throw new Error(`Refused: unknown service "${service}".`);
  if (!REGION_RE.test(String(region || ''))) throw new Error(`Refused: "${region}" is not a valid AWS region.`);
  return SERVICES[service](region);
}

// Segment grammar for ids. Instance ids are UUIDs; other Connect ids are
// UUIDs too, but test case and execution ids are documented only as
// "max 500 chars", so they get a plain-token pattern (no dots, colons, or
// anything URL-meaningful).
const INST = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,127}';

// [name, service, method, template, flags]. {i} = instance id, {id} = any id.
// flags: raw = reachable from connect_api_call (default true).
const OPS = [
  // instances
  ['ListInstances', 'connect', 'GET', '/instance'],
  ['DescribeInstance', 'connect', 'GET', '/instance/{i}'],
  // flows
  ['ListContactFlows', 'connect', 'GET', '/contact-flows-summary/{i}'],
  ['DescribeContactFlow', 'connect', 'GET', '/contact-flows/{i}/{id}'],
  ['CreateContactFlow', 'connect', 'PUT', '/contact-flows/{i}'],
  // Content updates go through build_flow only, which first proves no
  // phone number points at the flow (an update to a wired flow is live).
  ['UpdateContactFlowContent', 'connect', 'POST', '/contact-flows/{i}/{id}/content', { raw: false }],
  ['ListContactFlowModules', 'connect', 'GET', '/contact-flow-modules-summary/{i}'],
  ['SearchContactFlows', 'connect', 'POST', '/search-contact-flows'],
  // hours
  ['ListHoursOfOperations', 'connect', 'GET', '/hours-of-operations-summary/{i}'],
  ['DescribeHoursOfOperation', 'connect', 'GET', '/hours-of-operations/{i}/{id}'],
  ['CreateHoursOfOperation', 'connect', 'PUT', '/hours-of-operations/{i}'],
  ['SearchHoursOfOperations', 'connect', 'POST', '/search-hours-of-operations'],
  // queues
  ['ListQueues', 'connect', 'GET', '/queues-summary/{i}'],
  ['DescribeQueue', 'connect', 'GET', '/queues/{i}/{id}'],
  ['CreateQueue', 'connect', 'PUT', '/queues/{i}'],
  ['SearchQueues', 'connect', 'POST', '/search-queues'],
  // routing profiles
  ['ListRoutingProfiles', 'connect', 'GET', '/routing-profiles-summary/{i}'],
  ['DescribeRoutingProfile', 'connect', 'GET', '/routing-profiles/{i}/{id}'],
  ['ListRoutingProfileQueues', 'connect', 'GET', '/routing-profiles/{i}/{id}/queues'],
  ['CreateRoutingProfile', 'connect', 'PUT', '/routing-profiles/{i}'],
  ['SearchRoutingProfiles', 'connect', 'POST', '/search-routing-profiles'],
  // phone numbers: READ ONLY in v0.1
  ['ListPhoneNumbersV2', 'connect', 'POST', '/phone-number/list'],
  ['ListPhoneNumbers', 'connect', 'GET', '/phone-numbers-summary/{i}'],
  ['DescribePhoneNumber', 'connect', 'GET', '/phone-number/{id}'],
  ['ListFlowAssociations', 'connect', 'GET', '/flow-associations-summary/{i}'],
  // prompts, users (read)
  ['ListPrompts', 'connect', 'GET', '/prompts-summary/{i}'],
  ['DescribePrompt', 'connect', 'GET', '/prompts/{i}/{id}'],
  ['ListUsers', 'connect', 'GET', '/users-summary/{i}'],
  ['DescribeUser', 'connect', 'GET', '/users/{i}/{id}'],
  ['SearchUsers', 'connect', 'POST', '/search-users'],
  // native testing and simulation (a simulated contact, nothing dials)
  ['CreateTestCase', 'connect', 'PUT', '/test-cases/{i}'],
  ['DescribeTestCase', 'connect', 'GET', '/test-cases/{i}/{id}'],
  ['StartTestCaseExecution', 'connect', 'PUT', '/test-cases/{i}/{id}/start-execution'],
  ['GetTestCaseExecutionSummary', 'connect', 'GET', '/test-cases/{i}/{id}/{id}/summary'],
  ['ListTestCaseExecutionRecords', 'connect', 'GET', '/test-cases/{i}/{id}/{id}/records'],
  ['ListTestCaseExecutions', 'connect', 'GET', '/test-case-executions/{i}'],
  ['SearchTestCases', 'connect', 'POST', '/search-test-cases'],
  // outbound campaigns v2: READ ONLY in v0.1
  ['ListCampaigns', 'connect-campaigns', 'POST', '/v2/campaigns-summary'],
  ['DescribeCampaign', 'connect-campaigns', 'GET', '/v2/campaigns/{id}'],
  ['GetCampaignState', 'connect-campaigns', 'GET', '/v2/campaigns/{id}/state'],
  ['GetConnectInstanceConfig', 'connect-campaigns', 'GET', '/v2/connect-instance/{i}/config'],
].map(([name, service, method, template, flags = {}]) => ({
  name, service, method, template, raw: flags.raw !== false,
  re: new RegExp(`^${template.replace(/\{i\}/g, INST).replace(/\{id\}/g, ID)}$`),
}));

export const OPERATIONS = OPS.map(({ name, service, method, template, raw }) => ({ name, service, method, template, raw }));

// ---------- refusals on purpose (precise, polite) ----------

export const GO_LIVE_CHECKLIST = [
  'Test the flow end to end (run_flow_test simulates a call without a phone number).',
  'Confirm the hours of operation and time zone match the business.',
  'Confirm each queue has agents: a routing profile with the queue, and users on that routing profile.',
  'Decide what happens to callers on the number today (the old flow stops receiving calls the moment you switch).',
  'In the Amazon Connect console: Channels > Phone numbers > (the number) > Flow / IVR > choose the flow > Save. That is the go-live moment, and it is yours.',
];

const REFUSALS = [
  [(m) => m === 'DELETE', 'Refused: this server ships no deletes, and nothing in it can send a DELETE (Delete* APIs, disassociations, releases). Remove things in the Amazon Connect console if you mean to.'],
  [(m, p) => /^\/phone-number\/[^/]+\/contact-flow$/.test(p), `Refused: pointing a phone number at a flow (AssociatePhoneNumberContactFlow) is the go-live moment, and a human does it. Pre-flight checklist: ${GO_LIVE_CHECKLIST.join(' ')}`],
  [(m, p) => /^\/flow-associations\//.test(p) && m !== 'GET', `Refused: AssociateFlow wires a phone number (or email address) to a flow, which is the go-live moment, and a human does it. Pre-flight checklist: ${GO_LIVE_CHECKLIST.join(' ')}`],
  [(m, p) => /^\/phone-number\/(claim|import|search-available)$/.test(p), 'Refused: claiming, importing, or shopping for phone numbers is out of scope in v0.1 (number inventory is read only). Claim numbers in the Amazon Connect console.'],
  [(m, p) => /^\/phone-number\/(?!list$)[^/]+(\/metadata)?$/.test(p) && m !== 'GET', 'Refused: phone number records are read only here (UpdatePhoneNumber retargets a number, which moves live callers).'],
  [(m, p) => /^\/contact(\/|$)/.test(p) || /^\/contacts\//.test(p), 'Refused: live-contact APIs (Start*Contact, StartOutboundVoiceContact, transfer, stop, monitor, recording) are out of scope. Nothing here dials, messages, or touches a live contact.'],
  [(m, p, s) => s === 'connect-campaigns' && /\/(start|resume)$/.test(p), 'Refused: starting or resuming an outbound campaign is the moment dialing begins, and a human presses go in the Amazon Connect console.'],
  [(m, p, s) => s === 'connect-campaigns' && /\/(outbound-requests|profile-outbound-requests)$/.test(p), 'Refused: PutOutboundRequestBatch queues real outbound contacts. Nothing here dials.'],
  [(m, p) => /^\/(users|security-profiles|associate-security-profiles|disassociate-security-profiles|user-hierarchy)/.test(p) && m !== 'GET', 'Refused: user, security profile, and permission writes are out of scope (no IAM or security-profile writes). Users are read only here.'],
  [(m, p) => /^\/instance(\/|$)/.test(p) && m !== 'GET', 'Refused: instance configuration (attributes, storage, integrations, approved origins, replication) is out of scope.'],
];

// ---------- the guard ----------

const QUERY_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;

// Returns { ok: true, op, path, query } or { ok: false, message }.
// `path` must be absolute (leading slash) and already built from ids.
export function checkRequest({ service = 'connect', method, path, query, body } = {}) {
  const m = String(method || '').toUpperCase();
  const raw = String(path ?? '');
  if (!SERVICES[service]) return fail(`Refused: unknown service "${service}". Only connect and connect-campaigns are reachable.`);
  if (!['GET', 'PUT', 'POST', 'PATCH', 'DELETE'].includes(m)) return fail(`Refused: method "${method}" is not allowed.`);

  // 1. normalize: refuse anything that could be read two ways.
  if (!raw.startsWith('/')) return fail('Refused: the path must start with "/", e.g. /queues-summary/<instance-id>.');
  if (/^\/\//.test(raw) || /^[a-z]+:/i.test(raw)) return fail('Refused: absolute URLs and protocol-relative paths are not allowed; the host is pinned to Connect.');
  if (/[%;\\#?\s]/.test(raw)) return fail('Refused: the path may not contain %, ;, \\, #, ?, or whitespace. Pass query parameters in `query`.');
  const segs = raw.slice(1).split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return fail('Refused: empty, "." and ".." path segments are not allowed.');
  if (segs.some((s) => !/^[A-Za-z0-9_-]+$/.test(s))) return fail('Refused: path segments may only contain letters, digits, dash, and underscore (use ids, not ARNs, in paths).');

  // 2. query: identifier keys, no case-insensitive duplicates, scalars.
  const q = query && typeof query === 'object' && !Array.isArray(query) ? query : {};
  const keys = Object.keys(q);
  if (keys.some((k) => !QUERY_KEY.test(k))) return fail('Refused: query parameter names must be plain identifiers.');
  if (new Set(keys.map((k) => k.toLowerCase())).size !== keys.length) return fail('Refused: duplicate query parameters are not allowed.');
  if (Object.values(q).some((v) => v !== null && typeof v === 'object')) return fail('Refused: query values must be single scalars.');
  if (hasCaseDuplicateKeys(body)) return fail('Refused: the body repeats a field name with different casing.');

  // 3. refusals on purpose (named, so the model can explain them).
  for (const [test, message] of REFUSALS) if (test(m, raw, service)) return fail(message);

  // 4. allowlist.
  const op = OPS.find((o) => o.service === service && o.method === m && o.re.test(raw));
  if (!op) {
    return fail(`Refused: ${m} ${raw} (${service}) is not on this server's allowlist. It covers reads of instances, flows, hours, queues, routing profiles, phone numbers, prompts, users, and test cases, plus creating hours, queues, routing profiles, flows, and test cases. Deletes, go-live wiring, dialing, number inventory changes, and IAM or security profile writes are out of scope on purpose.`);
  }
  const cleanQuery = {};
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') cleanQuery[k] = String(v);
  return { ok: true, op: op.name, raw: op.raw, service, method: m, path: raw, query: cleanQuery };
}

// The raw tool (connect_api_call) adds one rule on top: operations flagged
// raw:false are typed-tool only.
export function checkRawCall(args = {}) {
  const c = checkRequest(args);
  if (!c.ok) return c;
  if (!c.raw) return fail(`Refused: ${c.op} is only reachable through the typed tool that guards it (build_flow with replace: true checks that no phone number points at the flow first).`);
  return c;
}

function fail(message) { return { ok: false, message }; }

function hasCaseDuplicateKeys(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 32) return false;
  if (Array.isArray(obj)) return obj.some((x) => hasCaseDuplicateKeys(x, depth + 1));
  const keys = Object.keys(obj).map((k) => k.toLowerCase());
  if (new Set(keys).size !== keys.length) return true;
  return Object.values(obj).some((v) => hasCaseDuplicateKeys(v, depth + 1));
}

// ---------- secret redaction ----------

// Connect GETs don't return credentials in practice, but the raw tool can
// read user records and instance data; scrub anything secret-shaped.
// NextToken / ClientToken are pagination and idempotency tokens, not secrets.
const SECRET_KEY = /passw|pwd|secret|token|accesskey|apikey|credential|sessionkey|privatekey/i;
const NOT_SECRET = /^(nexttoken|clienttoken|lasttoken)$/i;

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY.test(k) && !NOT_SECRET.test(k) && v !== null && v !== '' ? '[redacted]' : redactSecrets(v);
  }
  return out;
}

// Scrubs credentials out of free text (error messages echo request details).
export function redactText(s, secrets = []) {
  let out = String(s ?? '');
  for (const x of secrets) if (x && x.length >= 8) out = out.split(x).join('[redacted]');
  return out.replace(/(AKIA|ASIA)[A-Z0-9]{12,}/g, '[redacted-key-id]');
}

// ---------- argument validation (MCP schemas are advisory; enforce them) ----------

function typeOk(v, t) {
  if (t === 'string') return typeof v === 'string';
  if (t === 'integer') return Number.isInteger(v);
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (t === 'boolean') return typeof v === 'boolean';
  if (t === 'array') return Array.isArray(v);
  if (t === 'object') return v !== null && typeof v === 'object' && !Array.isArray(v);
  return true;
}

export function validateArgs(schema, args, path = 'arguments') {
  const errors = [];
  const walk = (s, v, p) => {
    if (!s || v === undefined) return;
    if (s.type && !typeOk(v, s.type)) { errors.push(`${p} must be ${s.type}`); return; }
    if (s.enum && !s.enum.includes(v)) errors.push(`${p} must be one of: ${s.enum.join(', ')}`);
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) errors.push(`${p} must be >= ${s.minimum}`);
      if (s.maximum !== undefined && v > s.maximum) errors.push(`${p} must be <= ${s.maximum}`);
    }
    if (Array.isArray(v)) {
      if (s.minItems !== undefined && v.length < s.minItems) errors.push(`${p} needs at least ${s.minItems} item(s)`);
      if (s.maxItems !== undefined && v.length > s.maxItems) errors.push(`${p} allows at most ${s.maxItems} item(s)`);
      if (s.items) v.forEach((x, i) => walk(s.items, x, `${p}[${i}]`));
    }
    if (s.type === 'object' && v && typeof v === 'object') {
      for (const r of s.required || []) if (v[r] === undefined) errors.push(`${p}.${r} is required`);
      for (const [k, x] of Object.entries(v)) {
        if (s.properties?.[k]) walk(s.properties[k], x, `${p}.${k}`);
        else if (s.additionalProperties === false) errors.push(`${p}.${k} is not a known argument`);
      }
    }
  };
  walk(schema, args ?? {}, path);
  return errors;
}
