// Tool-layer tests against an in-memory fetch stub (no AWS traffic). They
// prove the rails run BEFORE any network call, that requests are signed and
// pinned to the Connect host, and that build_flow sends a PUBLISHED flow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callTool, toolDefs, WRITE_TOOLS, TOOL_GROUPS } from '../src/tools.js';
import { ConnectClient } from '../src/connect.js';

const I = '11111111-2222-4333-8444-555555555555';
const ARN = (t, id) => `arn:aws:connect:us-east-1:111122223333:instance/${I}/${t}/${id}`;
const MAIN_LINE = JSON.parse(readFileSync(new URL('./fixtures/main_line.json', import.meta.url), 'utf8'));

function stub(routes = {}) {
  const state = { calls: [] };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const call = { method: init.method || 'GET', host: url.host, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined };
    state.calls.push(call);
    const key = `${call.method} ${call.path}`;
    const hit = Object.entries(routes).find(([k]) => new RegExp(`^${k}$`).test(key));
    const body = hit ? (typeof hit[1] === 'function' ? hit[1](call) : hit[1]) : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return state;
}
const cfg = { configured: true, accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', instanceId: I };

const BYPASSES = [
  { method: 'PUT', path: `/phone-number/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/contact-flow`, body: { InstanceId: I, ContactFlowId: 'x' } },
  { method: 'PUT', path: `/flow-associations/${I}`, body: { ResourceType: 'VOICE_PHONE_NUMBER' } },
  { method: 'PUT', path: '/contact/outbound-voice', body: { DestinationPhoneNumber: '+15555550100' } },
  { method: 'POST', path: '/v2/campaigns/abc/start', service: 'connect-campaigns' },
  { method: 'POST', path: '/phone-number/claim', body: {} },
  { method: 'GET', path: `/queues-summary/${I}/../../phone-number/x/contact-flow` },
  { method: 'GET', path: `/queues-summary/${I}%2F..%2F` },
  { method: 'GET', path: '//evil.example.com/instance' },
  { method: 'POST', path: `/contact-flows/${I}/abc/content`, body: { Content: '{}' } },
];

test('connect_api_call refuses every forbidden family before any network call', async () => {
  const state = stub();
  for (const args of BYPASSES) {
    await assert.rejects(callTool(cfg, 'connect_api_call', args), (e) => e.status === 403 && /^Refused/.test(e.message), JSON.stringify(args));
  }
  assert.equal(state.calls.length, 0);
});

test('the client itself refuses forbidden operations (typed tools cannot reach them either)', async () => {
  const state = stub();
  const cx = new ConnectClient(cfg);
  await assert.rejects(cx.request('DELETE', `/queues/${I}/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`), /no deletes/);
  await assert.rejects(cx.put('/phone-number/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/contact-flow', {}), /go-live/);
  await assert.rejects(cx.put('/contact/outbound-voice', {}), /live-contact/);
  await assert.rejects(cx.post('/v2/campaigns/x/resume', {}, { service: 'connect-campaigns' }), /dialing begins/);
  assert.equal(state.calls.length, 0);
});

test('fail closed: no access key, no request (and a clear message)', async () => {
  const state = stub();
  const cx = new ConnectClient({ region: 'us-east-1', instanceId: I });
  await assert.rejects(cx.get(`/instance/${I}`), /refusing to send an unsigned request/);
  await assert.rejects(callTool({ configured: false }, 'list_queues', {}), /not connected to Amazon Connect/);
  assert.equal(state.calls.length, 0);
});

test('requests are SigV4-signed and pinned to connect.<region>.amazonaws.com', async () => {
  const state = stub({ [`GET /queues-summary/${I}`]: { QueueSummaryList: [{ Id: 'q1', Arn: ARN('queue', 'q1'), Name: 'Sales' }], NextToken: null } });
  const res = await callTool({ ...cfg, sessionToken: 'SESSION' }, 'list_queues', {});
  assert.equal(res.total, 1);
  const c = state.calls[0];
  assert.equal(c.host, 'connect.us-east-1.amazonaws.com');
  assert.match(c.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/connect\/aws4_request, SignedHeaders=accept;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
  assert.equal(c.headers['x-amz-security-token'], 'SESSION');
  assert.deepEqual(c.query, { queueTypes: 'STANDARD', maxResults: '100' });
});

test('raw GETs send only the validated values and redact secrets', async () => {
  const state = stub({ [`GET /users/${I}/u1`]: { User: { Username: 'agent1', Password: 'hunter2' } } });
  const res = await callTool(cfg, 'connect_api_call', { method: 'GET', path: '/users/{instance}/u1' });
  assert.equal(res.User.Password, '[redacted]');
  assert.equal(res.User.Username, 'agent1');
  assert.equal(state.calls[0].path, `/users/${I}/u1`);
});

test('build_flow resolves names, compiles, and creates a PUBLISHED flow (no phone number wiring)', async () => {
  const queues = ['Sales', 'Support', 'Support_Escalations', 'Billing'].map((n) => ({ Id: `q-${n}`, Arn: ARN('queue', `q-${n}`), Name: `MCP_Test_${n}` }));
  const state = stub({
    [`GET /queues-summary/${I}`]: { QueueSummaryList: queues, NextToken: null },
    [`GET /hours-of-operations-summary/${I}`]: { HoursOfOperationSummaryList: [{ Id: 'h1', Arn: ARN('operating-hours', 'h1'), Name: 'MCP_Test_Main_Line Hours' }] },
    [`GET /contact-flows-summary/${I}`]: { ContactFlowSummaryList: [] },
    [`PUT /contact-flows/${I}`]: { ContactFlowId: 'f1', ContactFlowArn: ARN('contact-flow', 'f1') },
  });
  const queue_map = Object.fromEntries(['Sales', 'Support', 'Support_Escalations', 'Billing'].map((n) => [n, `MCP_Test_${n}`]));
  const res = await callTool(cfg, 'build_flow', { spec: MAIN_LINE, name: 'MCP_Test_Main_Line', queue_map });
  assert.equal(res.created, true, JSON.stringify(res));
  assert.equal(res.hours, 'MCP_Test_Main_Line Hours');
  assert.equal(res.gaps.length, 1);
  const put = state.calls.find((c) => c.method === 'PUT');
  assert.equal(put.path, `/contact-flows/${I}`);
  assert.equal(put.body.Status, 'PUBLISHED');
  assert.equal(put.body.Type, 'CONTACT_FLOW');
  const content = JSON.parse(put.body.Content);
  assert.ok(content.Actions.some((a) => a.Parameters?.QueueId === ARN('queue', 'q-Support_Escalations')));
  assert.ok(state.calls.every((c) => !/phone-number|flow-associations\//.test(c.path) || c.method === 'GET'));
});

test('build_flow relays InvalidContactFlowException problems verbatim', async () => {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if ((init.method || 'GET') === 'PUT') {
      return new Response(JSON.stringify({ problems: [{ message: 'Action is missing required error. Error: NoMatchingCondition, Path: Actions[1]' }] }), { status: 400, headers: { 'x-amzn-ErrorType': 'InvalidContactFlowException' } });
    }
    const body = url.pathname.startsWith('/queues-summary') ? { QueueSummaryList: [{ Id: 'q', Arn: ARN('queue', 'q'), Name: 'Front' }] } : url.pathname.startsWith('/contact-flows-summary') ? { ContactFlowSummaryList: [] } : {};
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const res = await callTool(cfg, 'build_flow', { spec: { name: 'X', menu: { prompt: 'Press 1.', options: [{ digit: '1', action: { type: 'transfer_to_queue', queue: 'Front' } }] } } });
  assert.equal(res.created, false);
  assert.deepEqual(res.problems, ['Action is missing required error. Error: NoMatchingCondition, Path: Actions[1]']);
});

test('build_flow refuses to replace a flow that a phone number points at', async () => {
  stub({
    [`GET /queues-summary/${I}`]: { QueueSummaryList: [{ Id: 'q', Arn: ARN('queue', 'q'), Name: 'Front' }] },
    [`GET /contact-flows-summary/${I}`]: { ContactFlowSummaryList: [{ Id: 'f1', Arn: ARN('contact-flow', 'f1'), Name: 'Live_Line' }] },
    [`GET /flow-associations-summary/${I}`]: { FlowAssociationSummaryList: [{ ResourceId: 'arn:phone', FlowId: ARN('contact-flow', 'f1'), ResourceType: 'VOICE_PHONE_NUMBER' }] },
  });
  const res = await callTool(cfg, 'build_flow', { spec: { name: 'Live_Line', menu: { prompt: 'Press 1.', options: [{ digit: '1', action: { type: 'transfer_to_queue', queue: 'Front' } }] } }, replace: true });
  assert.equal(res.created, false);
  assert.equal(res.stage, 'go-live guard');
});

test('build_flow reports missing queues instead of guessing', async () => {
  stub({
    [`GET /queues-summary/${I}`]: { QueueSummaryList: [{ Id: 'q', Arn: ARN('queue', 'q'), Name: 'Sales Team' }] },
    [`GET /hours-of-operations-summary/${I}`]: { HoursOfOperationSummaryList: [] },
  });
  const res = await callTool(cfg, 'build_flow', { spec: MAIN_LINE });
  assert.equal(res.created, false);
  assert.equal(res.stage, 'resolve queues');
  assert.ok(res.errors.some((e) => /Did you mean: Sales Team/.test(e)));
});

test('instance auto-discovery: one instance is used, two are refused with a list', async () => {
  stub({ 'GET /instance': { InstanceSummaryList: [{ Id: I, InstanceAlias: 'solo', InstanceStatus: 'ACTIVE' }] } });
  assert.equal(await new ConnectClient({ ...cfg, instanceId: '' }).instanceId(), I);
  stub({ 'GET /instance': { InstanceSummaryList: [{ Id: I, InstanceAlias: 'a', InstanceStatus: 'ACTIVE' }, { Id: '99999999-8888-4777-8666-555555555555', InstanceAlias: 'b', InstanceStatus: 'ACTIVE' }] } });
  await assert.rejects(new ConnectClient({ ...cfg, instanceId: '' }).instanceId(), /set CONNECT_INSTANCE_ID.*a \(.*b \(/);
  await assert.rejects(new ConnectClient({ ...cfg, instanceId: 'nope' }).instanceId(), /not a Connect instance id/);
});

test('tool registry: every tool is grouped, writes are badged, descriptions have no em dashes', () => {
  const defs = toolDefs();
  const grouped = new Set(TOOL_GROUPS.flatMap((g) => g.tools));
  for (const d of defs) {
    assert.ok(grouped.has(d.name), `${d.name} is not in a TOOL_GROUP`);
    assert.doesNotMatch(d.description, /\u2014/, d.name);
  }
  for (const w of WRITE_TOOLS) assert.ok(defs.some((d) => d.name === w), w);
  assert.ok(!defs.some((d) => /delete|associate_phone|start_campaign|dial/i.test(d.name)));
});
