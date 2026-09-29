// Live smoke test against a real Amazon Connect instance, exercising the
// tool layer directly (no Worker needed). Reads credentials from .env in the
// repo root (gitignored): AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
// AWS_SESSION_TOKEN (optional), AWS_REGION, CONNECT_INSTANCE_ID.
//
// For SSO profiles, export temporary credentials first:
//   aws configure export-credentials --profile <profile> --format env | sed 's/^export //' > .env
//
// Read-only by default. --writes builds ONLY MCP_Test_-prefixed artifacts
// (hours, 4 queues, a routing profile, the Main_Line flow) and runs native
// test cases against the flow. Nothing is deleted; artifacts are receipts.
// --negative also runs a test that MUST fail (wrong expected queue).
import { readFileSync } from 'node:fs';
import { callTool } from '../src/tools.js';
import { isDeepStrictEqual } from 'node:util';
import { normalizeSpec } from '../src/flows.js';

const env = Object.fromEntries(
  readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).replace(/^export\s+/, '').trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const cfg = {
  accessKeyId: env.AWS_ACCESS_KEY_ID,
  secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  sessionToken: env.AWS_SESSION_TOKEN,
  region: env.AWS_REGION || 'us-east-1',
  instanceId: env.CONNECT_INSTANCE_ID,
  configured: true,
};

const WRITES = process.argv.includes('--writes');
const NEGATIVE = process.argv.includes('--negative');
const P = 'MCP_Test_';
const receipts = {};
let pass = 0;
let fail = 0;

async function step(name, fn, check = () => true) {
  const t0 = Date.now();
  try {
    const out = await fn();
    const ok = check(out);
    if (ok !== true) throw new Error(`check failed${typeof ok === 'string' ? `: ${ok}` : ''}: ${JSON.stringify(out).slice(0, 600)}`);
    console.log(`PASS  ${name} (${Date.now() - t0}ms)`);
    pass++;
    return out;
  } catch (e) {
    console.log(`FAIL  ${name}: ${e.message}`);
    fail++;
    return null;
  }
}
const call = (name, args = {}) => callTool(cfg, name, args);
const refusedBy = async (args, re) => {
  try { await call('connect_api_call', args); return { refused: false }; } catch (e) { return { refused: re.test(e.message), message: e.message }; }
};

// ---------- reads ----------
const conn = await step('check_connection', () => call('check_connection'), (o) => o.ok && o.instance.status === 'ACTIVE');
if (conn) console.log(`      instance ${conn.instance.alias} (${conn.instance.id}), test cases: ${conn.nativeTestCases}, campaigns: ${conn.outboundCampaigns}`);
await step('about', () => call('about'), (o) => typeof o === 'string' && o.includes('landmines') && !o.includes('\u2014'));
await step('list_instances', () => call('list_instances'), (o) => o.total >= 1);
await step('contact_center_overview', () => call('contact_center_overview'), (o) => Array.isArray(o.queues) && Array.isArray(o.flows) && Array.isArray(o.phoneNumbers));
await step('list_contact_flows', () => call('list_contact_flows'), (o) => o.total >= 1);
await step('list_contact_flows all types', () => call('list_contact_flows', { type: 'all' }), (o) => o.flows.some((f) => f.type === 'CUSTOMER_QUEUE'));
await step('get_contact_flow (AWS sample)', () => call('get_contact_flow', { flow: 'Sample inbound flow (first contact experience)' }), (o) => o.content?.Actions?.length > 5);
await step('render_flow actions (AWS sample, foreign flow)', () => call('render_flow', { flow: 'Sample inbound flow (first contact experience)', detail: 'actions' }), (o) => o.mermaid.startsWith('flowchart TD'));
await step('export_flow_spec (AWS sample, foreign flow)', () => call('export_flow_spec', { flow: 'Sample inbound flow (first contact experience)' }), (o) => o.spec && Array.isArray(o.warnings));
await step('list_hours_of_operation', () => call('list_hours_of_operation'), (o) => o.hours.some((h) => h.alwaysOpen));
await step('get_hours_of_operation', () => call('get_hours_of_operation', { hours: 'Basic Hours' }), (o) => o.alwaysOpen === true && Boolean(o.spec.timezone));
await step('list_queues', () => call('list_queues'), (o) => o.total >= 1);
await step('get_queue', () => call('get_queue', { queue: 'BasicQueue' }), (o) => o.hoursOfOperation === 'Basic Hours');
await step('list_routing_profiles', () => call('list_routing_profiles'), (o) => o.total >= 1);
await step('get_routing_profile', () => call('get_routing_profile', { routing_profile: 'Basic Routing Profile' }), (o) => o.mediaConcurrency.VOICE === 1 && o.queues.length >= 1);
await step('list_phone_numbers', () => call('list_phone_numbers'), (o) => Array.isArray(o.phoneNumbers));
await step('list_prompts', () => call('list_prompts'), (o) => o.total >= 1);
await step('list_users', () => call('list_users'), (o) => 'total' in o);
await step('outbound_readiness', () => call('outbound_readiness'), (o) => typeof o.onboarded === 'boolean');
await step('connect_api_call GET', () => call('connect_api_call', { method: 'GET', path: '/queues-summary/{instance}', query: { queueTypes: 'STANDARD', maxResults: 5 } }), (o) => Array.isArray(o.QueueSummaryList));
await step('render_flow (spec preview, no AWS call)', () => call('render_flow', { spec: JSON.parse(readFileSync(new URL('../test/fixtures/main_line.json', import.meta.url), 'utf8')) }), (o) => o.valid && o.gaps.length === 1);

// ---------- refusal rails (through the tool layer; nothing is sent) ----------
await step('refuses DELETE (schema has no DELETE at all)', () => refusedBy({ method: 'DELETE', path: '/queues/{instance}/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, /must be one of: GET, PUT, POST|no deletes/), (o) => o.refused);
await step('refuses AssociatePhoneNumberContactFlow', () => refusedBy({ method: 'PUT', path: '/phone-number/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/contact-flow', body: {} }, /go-live/), (o) => o.refused);
await step('refuses AssociateFlow', () => refusedBy({ method: 'PUT', path: '/flow-associations/{instance}', body: {} }, /go-live/), (o) => o.refused);
await step('refuses StartOutboundVoiceContact', () => refusedBy({ method: 'PUT', path: '/contact/outbound-voice', body: {} }, /live-contact/), (o) => o.refused);
await step('refuses StartCampaign', () => refusedBy({ method: 'POST', path: '/v2/campaigns/abc/start', service: 'connect-campaigns' }, /dialing begins/), (o) => o.refused);
await step('refuses ClaimPhoneNumber', () => refusedBy({ method: 'POST', path: '/phone-number/claim', body: {} }, /claiming/), (o) => o.refused);
await step('refuses traversal', () => refusedBy({ method: 'GET', path: '/queues-summary/{instance}/../../phone-number/x/contact-flow' }, /segments/), (o) => o.refused);

// ---------- writes: build the Main_Line contact center, then prove it ----------
if (WRITES) {
  const spec = JSON.parse(readFileSync(new URL('../test/fixtures/main_line.json', import.meta.url), 'utf8'));
  const flowName = `${P}Main_Line`;
  const hoursName = `${flowName} Hours`;
  const queueNames = ['Sales', 'Support', 'Support_Escalations', 'Billing'];
  const queue_map = Object.fromEntries(queueNames.map((n) => [n, `${P}${n}`]));

  const hours = await step('create_hours_of_operation', () => call('create_hours_of_operation', { name: hoursName, hours: spec.hours, description: 'Main_Line business hours (amazon-connect-mcp smoke test).' }), (o) => Boolean(o.id));
  if (hours) receipts.hours = { name: hoursName, id: hours.id, arn: hours.arn, created: hours.created };
  receipts.queues = {};
  for (const n of queueNames) {
    const q = await step(`create_queue ${P}${n}`, () => call('create_queue', { name: `${P}${n}`, hours_of_operation: hoursName, description: `${n} queue for the Main_Line IVR (amazon-connect-mcp smoke test).` }), (o) => Boolean(o.id));
    if (q) receipts.queues[`${P}${n}`] = { id: q.id, arn: q.arn, created: q.created };
  }
  const rp = await step('create_routing_profile', () => call('create_routing_profile', {
    name: `${P}Main_Line_Agents`,
    description: 'Agents for the Main_Line IVR queues (amazon-connect-mcp smoke test).',
    queues: queueNames.map((n, k) => ({ queue: `${P}${n}`, priority: n === 'Support_Escalations' ? 1 : 2, delay: 0 })),
    media: { voice: 1 },
  }), (o) => Boolean(o.id));
  if (rp) receipts.routingProfile = { name: `${P}Main_Line_Agents`, id: rp.id, arn: rp.arn, created: rp.created };

  const built = await step('build_flow Main_Line (PUBLISHED, server-validated)', () => call('build_flow', { spec, name: flowName, queue_map, replace: true }), (o) => (o.created || o.replaced) && o.status === 'PUBLISHED' && o.gaps.length === 1 ? true : JSON.stringify(o.problems || o.errors || o));
  if (built) receipts.flow = { name: flowName, id: built.id, arn: built.arn, actions: built.actions, created: Boolean(built.created), replaced: Boolean(built.replaced) };

  await step('export_flow_spec round-trips to the source spec', async () => {
    const ex = await call('export_flow_spec', { flow: flowName });
    const expected = normalizeSpec({ ...spec, name: flowName, hours: { ...spec.hours, hours_of_operation: hoursName } });
    const got = normalizeSpec(ex.spec);
    return { equal: isDeepStrictEqual(got, expected), got, expected, gaps: ex.gaps };
  }, (o) => o.equal || `diff: got ${JSON.stringify(o.got).slice(0, 400)}`);
  await step('render_flow (built flow, spec view)', () => call('render_flow', { flow: flowName }), (o) => /Queue: Support_Escalations/.test(o.mermaid));
  await step('get_contact_flow (built flow)', () => call('get_contact_flow', { flow: flowName, include_content: false }), (o) => o.status === 'PUBLISHED' && o.phoneNumbers.length === 0);
  await step('go_live_checklist (read only)', () => call('go_live_checklist', { flow: flowName }), (o) => o.flow.published && o.queues.length === 4 && o.queues.every((q) => q.routingProfiles.length === 1 && q.staffed === false && /no users/.test(q.warning)));

  receipts.tests = [];
  const runs = [
    { digits: ['2', '1'], expect_queue: `${P}Support`, want: 'PASSED', why: 'press 2 (Support menu) then 1 (new issue) lands in Support' },
    { digits: ['1'], expect_queue: `${P}Sales`, want: 'PASSED', why: 'press 1 lands in Sales (after the transfer message)' },
    { digits: ['2', '9', '3'], expect_queue: `${P}Billing`, want: 'PASSED', why: 'press 2, then 9 goes back, then 3 lands in Billing' },
  ];
  if (NEGATIVE) runs.push({ digits: ['2', '2'], expect_queue: `${P}Support`, want: 'FAILED', why: 'NEGATIVE: press 2 then 2 goes to Support_Escalations, so expecting Support must fail', wait: 150 });
  for (const r of runs) {
    const t = await step(`run_flow_test ${r.digits.join(',')} -> ${r.expect_queue} (expect ${r.want})`, () => call('run_flow_test', { flow: flowName, digits: r.digits, expect_queue: r.expect_queue, name_prefix: P, wait_seconds: r.wait || 150 }), (o) => o.verdict === r.want || `verdict ${o.verdict}`);
    if (t) {
      receipts.tests.push({ path: r.digits.join(','), why: r.why, verdict: t.verdict, failures: t.failures?.length ? t.failures : undefined, testCaseName: t.testCaseName, observations: t.observations, testCaseId: t.testCaseId, executionId: t.executionId, simulatedContactId: t.simulatedContactId, durationMs: t.completion?.durationMs });
      for (const s of t.transcript || []) console.log(`      ${s.status.padEnd(6)} ${s.step}${s.heard ? `  heard: "${s.heard}"` : ''}${s.flowAction ? `  -> ${s.flowAction.type}` : ''}`);
      for (const x of t.failures || []) console.log(`      failure: ${JSON.stringify(x)}`);
      for (const n of t.notes || []) console.log(`      note: ${n}`);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (WRITES) console.log(`\nRECEIPTS\n${JSON.stringify(receipts, null, 2)}`);
process.exit(fail ? 1 : 0);
