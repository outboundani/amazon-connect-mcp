import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRequest, checkRawCall, redactSecrets, redactText, hostFor, validateArgs, OPERATIONS } from '../src/rules.js';

const I = '11111111-2222-4333-8444-555555555555';
const Q = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const refused = (call, re) => {
  const r = checkRawCall(call);
  assert.equal(r.ok, false, `expected refusal for ${JSON.stringify(call)}`);
  if (re) assert.match(r.message, re);
  return r;
};
const allowed = (call) => {
  const r = checkRawCall(call);
  assert.equal(r.ok, true, `expected allow for ${JSON.stringify(call)}: ${r.message}`);
  return r;
};

// ---------- the promises (code-level rails) ----------

test('rail: NO Delete* anything (every DELETE refused, any path, any service)', () => {
  for (const path of [`/queues/${I}/${Q}`, `/contact-flows/${I}/${Q}`, `/hours-of-operations/${I}/${Q}`, `/routing-profiles/${I}/${Q}`, `/phone-number/${Q}`, `/phone-number/${Q}/contact-flow`, `/instance/${I}`, `/users/${I}/${Q}`, `/test-cases/${I}/${Q}`]) {
    refused({ method: 'DELETE', path }, /no deletes/);
  }
  refused({ method: 'DELETE', path: `/v2/campaigns/${Q}`, service: 'connect-campaigns' }, /no deletes/);
});

test('rail: never AssociatePhoneNumberContactFlow or AssociateFlow (go-live is human)', () => {
  refused({ method: 'PUT', path: `/phone-number/${Q}/contact-flow`, body: { InstanceId: I, ContactFlowId: Q } }, /go-live moment/);
  refused({ method: 'POST', path: `/phone-number/${Q}/contact-flow` }, /go-live moment/);
  refused({ method: 'PUT', path: `/flow-associations/${I}`, body: { ResourceId: 'arn', FlowId: 'arn', ResourceType: 'VOICE_PHONE_NUMBER' } }, /AssociateFlow/);
  const r = checkRawCall({ method: 'PUT', path: `/phone-number/${Q}/contact-flow` });
  assert.match(r.message, /Pre-flight checklist/);
});

test('rail: never UpdatePhoneNumber, claim, release, or import numbers', () => {
  refused({ method: 'PUT', path: `/phone-number/${Q}`, body: { TargetArn: 'arn:aws:connect:us-east-1:1:instance/x' } }, /read only/);
  refused({ method: 'PUT', path: `/phone-number/${Q}/metadata` }, /read only/);
  refused({ method: 'POST', path: '/phone-number/claim' }, /claiming/);
  refused({ method: 'POST', path: '/phone-number/import' }, /claiming/);
  refused({ method: 'POST', path: '/phone-number/search-available' }, /claiming/);
  allowed({ method: 'POST', path: '/phone-number/list', body: { InstanceId: I } });
  allowed({ method: 'GET', path: `/phone-number/${Q}` });
});

test('rail: never Start*Contact / StartOutboundVoiceContact / live-contact APIs', () => {
  for (const p of ['/contact/outbound-voice', '/contact/chat', '/contact/task', '/contact/webrtc', '/contact/email', '/contact/outbound-chat', '/contact/outbound-email']) {
    refused({ method: 'PUT', path: p }, /live-contact/);
  }
  for (const p of ['/contact/stop', '/contact/transfer', '/contact/monitor', '/contact/start-recording', '/contact/resume']) refused({ method: 'POST', path: p }, /live-contact/);
  refused({ method: 'GET', path: `/contacts/${I}/${Q}/something` }, /live-contact/);
});

test('rail: never StartCampaign / ResumeCampaign / outbound requests', () => {
  refused({ method: 'POST', path: `/v2/campaigns/${Q}/start`, service: 'connect-campaigns' }, /dialing begins/);
  refused({ method: 'POST', path: `/v2/campaigns/${Q}/resume`, service: 'connect-campaigns' }, /dialing begins/);
  refused({ method: 'PUT', path: `/v2/campaigns/${Q}/outbound-requests`, service: 'connect-campaigns' }, /Nothing here dials/);
  refused({ method: 'PUT', path: '/v2/campaigns', service: 'connect-campaigns', body: { name: 'x' } }, /allowlist/);
  allowed({ method: 'POST', path: '/v2/campaigns-summary', service: 'connect-campaigns', body: {} });
  allowed({ method: 'GET', path: `/v2/connect-instance/${I}/config`, service: 'connect-campaigns' });
});

test('rail: no IAM, user, security profile, or instance writes', () => {
  refused({ method: 'PUT', path: `/users/${I}`, body: { Username: 'x' } }, /security profile/);
  refused({ method: 'POST', path: `/users/${I}/${Q}/security-profiles` }, /security profile/);
  refused({ method: 'POST', path: `/users/${I}/${Q}/routing-profile` }, /security profile/);
  refused({ method: 'PUT', path: `/security-profiles/${I}` }, /security profile/);
  refused({ method: 'POST', path: `/associate-security-profiles/${I}` }, /security profile/);
  refused({ method: 'PUT', path: '/instance', body: {} }, /instance configuration/);
  refused({ method: 'POST', path: `/instance/${I}/attribute/INBOUND_CALLS` }, /instance configuration/);
  allowed({ method: 'GET', path: `/users/${I}/${Q}` });
  allowed({ method: 'GET', path: `/users-summary/${I}` });
});

test('rail: typed-only operations are not reachable from the raw tool', () => {
  const typed = checkRequest({ method: 'POST', path: `/contact-flows/${I}/${Q}/content`, body: { Content: '{}' } });
  assert.equal(typed.ok, true);
  refused({ method: 'POST', path: `/contact-flows/${I}/${Q}/content`, body: { Content: '{}' } }, /typed tool/);
});

// ---------- normalize-then-allowlist: traversal, encoding, host bypass regressions ----------

test('bypass: dot-segment traversal is refused before any matching', () => {
  refused({ method: 'GET', path: `/queues-summary/${I}/../../phone-number/${Q}/contact-flow` }, /segments/);
  refused({ method: 'PUT', path: `/hours-of-operations/${I}/../../phone-number/${Q}/contact-flow` }, /segments/);
  refused({ method: 'GET', path: `/queues-summary/./${I}` }, /segments/);
  refused({ method: 'GET', path: `/queues-summary//${I}` }, /segments/);
  refused({ method: 'GET', path: `/queues-summary/${I}/` }, /segments/);
});

test('bypass: percent-encoding, matrix params, backslashes, fragments, and query strings are refused', () => {
  refused({ method: 'PUT', path: `/phone-number/${Q}%2Fcontact-flow` }, /may not contain/);
  refused({ method: 'DELETE', path: `/queues/${I}/%2e%2e/x` });
  refused({ method: 'GET', path: `/queues-summary/${I};x=1` }, /may not contain/);
  refused({ method: 'GET', path: `/queues-summary\\${I}` }, /may not contain/);
  refused({ method: 'GET', path: `/queues-summary/${I}#x` }, /may not contain/);
  refused({ method: 'GET', path: `/queues-summary/${I}?maxResults=1` }, /may not contain/);
  refused({ method: 'GET', path: `/queues-summary/ ${I}` }, /may not contain/);
});

test('bypass: host injection is impossible (absolute URLs, protocol-relative, ARNs in paths)', () => {
  refused({ method: 'GET', path: 'https://evil.example.com/instance' }, /start with/);
  refused({ method: 'GET', path: '//evil.example.com/instance' }, /pinned/);
  refused({ method: 'GET', path: '@evil.example.com/instance' }, /start with/);
  refused({ method: 'GET', path: `/contact-flows/${I}/arn:aws:connect:us-east-1:1:instance/x/contact-flow/y` }, /letters, digits/);
  refused({ method: 'GET', path: `/instance/${I}`, service: 'sts' }, /unknown service/);
  refused({ method: 'GET', path: `/instance/${I}`, service: 'iam' }, /unknown service/);
  assert.equal(hostFor('connect', 'us-east-1'), 'connect.us-east-1.amazonaws.com');
  assert.equal(hostFor('connect-campaigns', 'eu-west-2'), 'connect-campaigns.eu-west-2.amazonaws.com');
  assert.equal(hostFor('connect', 'us-gov-west-1'), 'connect.us-gov-west-1.amazonaws.com');
  assert.throws(() => hostFor('connect', 'us-east-1.evil.com'), /not a valid AWS region/);
  assert.throws(() => hostFor('connect', 'evil.com/'), /not a valid AWS region/);
  assert.throws(() => hostFor('connect', ''), /not a valid AWS region/);
});

test('bypass: the instance id must be a UUID, so ids cannot smuggle other templates', () => {
  refused({ method: 'GET', path: '/queues-summary/not-a-uuid' }, /allowlist/);
  refused({ method: 'PUT', path: '/queues/INSTANCE' }, /allowlist/);
});

test('query: identifier keys, unique case-insensitively, scalar values', () => {
  refused({ method: 'GET', path: `/queues-summary/${I}`, query: { 'max-results': 1 } }, /identifiers/);
  refused({ method: 'GET', path: `/queues-summary/${I}`, query: { maxResults: 1, MAXRESULTS: 2 } }, /duplicate/);
  refused({ method: 'GET', path: `/queues-summary/${I}`, query: { queueTypes: ['STANDARD', 'AGENT'] } }, /scalars/);
  refused({ method: 'GET', path: `/queues-summary/${I}`, query: { x: { y: 1 } } }, /scalars/);
  const r = allowed({ method: 'GET', path: `/queues-summary/${I}`, query: { maxResults: 5, nextToken: '', queueTypes: 'STANDARD' } });
  assert.deepEqual(r.query, { maxResults: '5', queueTypes: 'STANDARD' });
});

test('body: case-duplicate keys are refused (ambiguous to case-insensitive binders)', () => {
  refused({ method: 'PUT', path: `/queues/${I}`, body: { Name: 'a', name: 'b', HoursOfOperationId: Q } }, /casing/);
  refused({ method: 'PUT', path: `/queues/${I}`, body: { Name: 'a', OutboundCallerConfig: { OutboundFlowId: 'x', outboundflowid: 'y' } } }, /casing/);
});

test('allowlist: the reads and creates the typed tools use are allowed', () => {
  allowed({ method: 'GET', path: '/instance' });
  allowed({ method: 'GET', path: `/instance/${I}` });
  allowed({ method: 'GET', path: `/contact-flows-summary/${I}` });
  allowed({ method: 'GET', path: `/contact-flows/${I}/${Q}` });
  allowed({ method: 'PUT', path: `/contact-flows/${I}`, body: { Name: 'x', Type: 'CONTACT_FLOW', Content: '{}' } });
  allowed({ method: 'PUT', path: `/hours-of-operations/${I}`, body: {} });
  allowed({ method: 'PUT', path: `/queues/${I}`, body: {} });
  allowed({ method: 'PUT', path: `/routing-profiles/${I}`, body: {} });
  allowed({ method: 'GET', path: `/routing-profiles/${I}/${Q}/queues` });
  allowed({ method: 'GET', path: `/flow-associations-summary/${I}`, query: { ResourceType: 'VOICE_PHONE_NUMBER' } });
  allowed({ method: 'PUT', path: `/test-cases/${I}`, body: {} });
  allowed({ method: 'PUT', path: `/test-cases/${I}/${Q}/start-execution`, body: {} });
  allowed({ method: 'GET', path: `/test-cases/${I}/${Q}/12345678-1234-3234-8234-123456789abc/summary` });
  allowed({ method: 'GET', path: `/test-cases/${I}/${Q}/12345678-1234-3234-8234-123456789abc/records` });
});

test('allowlist: anything unlisted is refused (update/associate families not shipped)', () => {
  refused({ method: 'POST', path: `/queues/${I}/${Q}/status` }, /allowlist/);
  refused({ method: 'POST', path: `/queues/${I}/${Q}/outbound-caller-config` }, /allowlist/);
  refused({ method: 'POST', path: `/routing-profiles/${I}/${Q}/associate-queues` }, /allowlist/);
  refused({ method: 'POST', path: `/hours-of-operations/${I}/${Q}` }, /allowlist/);
  refused({ method: 'PUT', path: `/prompts/${I}` }, /allowlist/);
  refused({ method: 'PATCH', path: `/queues/${I}/${Q}` }, /allowlist/);
  refused({ method: 'OPTIONS', path: '/instance' }, /not allowed/);
});

test('the operation table never contains a forbidden operation', () => {
  const names = OPERATIONS.map((o) => o.name);
  for (const n of names) {
    assert.doesNotMatch(n, /^(Delete|Disassociate|Release|Claim|Import|StartOutbound|StartChat|StartTask|StartWebRTC|StartEmail|StartCampaign|ResumeCampaign|AssociatePhoneNumber|AssociateFlow|UpdatePhoneNumber|CreateUser|UpdateUser|CreateSecurityProfile|UpdateSecurityProfile)/, n);
  }
  assert.ok(OPERATIONS.every((o) => o.method !== 'DELETE'));
});

// ---------- redaction + validation ----------

test('secrets are redacted, pagination tokens are not', () => {
  const r = redactSecrets({ NextToken: 'abc', ClientToken: 'c', User: { Password: 'p', SecretAccessKey: 'k', SessionToken: 't', nested: [{ apiKey: 'z' }] }, Name: 'ok' });
  assert.equal(r.NextToken, 'abc');
  assert.equal(r.ClientToken, 'c');
  assert.equal(r.User.Password, '[redacted]');
  assert.equal(r.User.SecretAccessKey, '[redacted]');
  assert.equal(r.User.SessionToken, '[redacted]');
  assert.equal(r.User.nested[0].apiKey, '[redacted]');
  assert.equal(r.Name, 'ok');
  assert.equal(redactText('bad key AKIAIOSFODNN7EXAMPLE and secret wJalrXUtnFEMI', ['wJalrXUtnFEMI']), 'bad key [redacted-key-id] and secret [redacted]');
});

test('validateArgs enforces the schema (MCP schemas are advisory)', () => {
  const schema = { type: 'object', properties: { digits: { type: 'array', items: { type: 'string' }, minItems: 1 }, hours: { type: 'string', enum: ['force_open', 'as_is'] } }, required: ['digits'], additionalProperties: false };
  assert.deepEqual(validateArgs(schema, { digits: ['1'] }), []);
  assert.ok(validateArgs(schema, {}).some((e) => /digits is required/.test(e)));
  assert.ok(validateArgs(schema, { digits: [1] }).some((e) => /must be string/.test(e)));
  assert.ok(validateArgs(schema, { digits: ['1'], hours: 'closed' }).some((e) => /one of/.test(e)));
  assert.ok(validateArgs(schema, { digits: ['1'], extra: 1 }).some((e) => /not a known argument/.test(e)));
});
