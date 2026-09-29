// MCP tool definitions + dispatch. Each tool maps to one or a few Amazon
// Connect API calls and returns plain JSON for the model.
//
// Scope is deliberate: config reads + create/build actions + native flow
// tests. NO deletes, NO go-live wiring (no tool can point a phone number at
// a flow), NO dialing (no Start*Contact, no campaign start/resume), NO
// phone number claims or releases, NO IAM or security profile writes. The
// client enforces the same allowlist on every request (src/rules.js), and
// docs/iam-policy.json makes AWS enforce it too. A human presses go.
//
// Amazon Connect vocabulary: a FLOW (contact flow) is the IVR; a QUEUE
// holds callers and has HOURS OF OPERATION; a ROUTING PROFILE decides which
// queues an agent works and how many contacts at once; a PHONE NUMBER is
// wired to a flow (that wiring is the go-live moment).

import { ConnectClient, ConnectError } from './connect.js';
import { ABOUT } from './about.js';
import { checkRawCall, redactSecrets, validateArgs, GO_LIVE_CHECKLIST } from './rules.js';
import {
  validateSpec, compileFlow, validateFlowContent, exportFlowSpec, specToMermaid, flowToMermaid,
  specHoursToConfig, configToSchedule, isAlwaysOpen,
} from './flows.js';
import { buildTestContent, summarizeRecords } from './testcases.js';

const TAGS = { 'created-by': 'amazon-connect-mcp' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- resolvers (names -> ids, exact for writes, partial for reads) ----------

async function listQueues(cx) {
  const i = await cx.instanceId();
  return (await cx.listAll(`/queues-summary/${i}`, 'QueueSummaryList', { queueTypes: 'STANDARD' })).entities;
}
async function listHours(cx) {
  const i = await cx.instanceId();
  return (await cx.listAll(`/hours-of-operations-summary/${i}`, 'HoursOfOperationSummaryList')).entities;
}
async function listFlows(cx, types) {
  const i = await cx.instanceId();
  return (await cx.listAll(`/contact-flows-summary/${i}`, 'ContactFlowSummaryList', types ? { contactFlowTypes: types } : {})).entities;
}
async function listRoutingProfiles(cx) {
  const i = await cx.instanceId();
  return (await cx.listAll(`/routing-profiles-summary/${i}`, 'RoutingProfileSummaryList')).entities;
}

// Generic resolver over summary rows ({Id, Arn, Name}). `exact` (writes)
// refuses partial matches and suggests near ones instead of guessing.
function pick(rows, ref, what, { exact = false } = {}) {
  const r = String(ref ?? '').trim();
  if (!r) throw new ConnectError(`A ${what} name or id is required.`, 400, 'InvalidParameter');
  const byId = rows.find((x) => x.Id === r || x.Arn === r);
  if (byId) return byId;
  const lower = r.toLowerCase();
  const eq = rows.filter((x) => String(x.Name).toLowerCase() === lower);
  if (eq.length === 1) return eq[0];
  if (eq.length > 1) throw new ConnectError(`Ambiguous ${what} "${r}": ${eq.map((x) => `${x.Name} (${x.Id})`).join(', ')}. Use the id.`, 409, 'Ambiguous');
  const near = rows.filter((x) => String(x.Name).toLowerCase().includes(lower));
  if (!exact && near.length === 1) return near[0];
  if (near.length) throw new ConnectError(`No ${what} named exactly "${r}". Did you mean: ${near.slice(0, 8).map((x) => x.Name).join(', ')}?`, 404, 'NotFound');
  throw new ConnectError(`No ${what} found matching "${r}".`, 404, 'NotFound');
}

async function describeFlow(cx, ref, { exact = false } = {}) {
  const i = await cx.instanceId();
  const row = pick(await listFlows(cx), ref, 'flow', { exact });
  const res = await cx.get(`/contact-flows/${i}/${row.Id}`);
  return res.ContactFlow;
}

// Phone number ARN -> flow ARN, for every voice number in the instance.
async function phoneAssociations(cx) {
  const i = await cx.instanceId();
  const { entities } = await cx.listAll(`/flow-associations-summary/${i}`, 'FlowAssociationSummaryList', { ResourceType: 'VOICE_PHONE_NUMBER' });
  return entities;
}

async function phoneNumbers(cx) {
  const i = await cx.instanceId();
  return (await cx.listAllPost('/phone-number/list', 'ListPhoneNumbersSummaryList', { InstanceId: i })).entities;
}

async function hoursDetail(cx, id) {
  const i = await cx.instanceId();
  return (await cx.get(`/hours-of-operations/${i}/${id}`)).HoursOfOperation;
}

// Everything the exporter needs to name things: queue ARN -> name, hours
// ARN -> {name, timezone, schedule}.
async function exportContext(cx, content) {
  const c = typeof content === 'string' ? JSON.parse(content) : content;
  const queueNameByArn = Object.fromEntries((await listQueues(cx)).map((q) => [q.Arn, q.Name]));
  const hours = {};
  for (const a of c.Actions || []) {
    if (a.Type !== 'CheckHoursOfOperation' || !a.Parameters?.HoursOfOperationId) continue;
    const arn = a.Parameters.HoursOfOperationId;
    const id = String(arn).split('/').pop();
    try {
      const h = await hoursDetail(cx, id);
      hours[arn] = { name: h.Name, timezone: h.TimeZone, schedule: configToSchedule(h.Config) };
    } catch { /* leave unresolved; exporter falls back to the ARN */ }
  }
  return { queueNameByArn, hours };
}

const summarizeQueue = (q) => ({ id: q.Id, name: q.Name, arn: q.Arn });

// Plain-words list of what failed in a native test run.
function failuresOf(records) {
  const out = [];
  for (const s of records.steps || []) {
    if (s.status !== 'FAILED') continue;
    const bad = (s.actions || []).filter((x) => x.status === 'FAILED');
    if (!bad.length) out.push({ step: s.step, heard: s.heard, expected: s.expected });
    for (const x of bad) out.push(x.type === 'Assert' ? { step: s.step, check: x.check, actual: x.actualValue } : { step: s.step, action: x.type, expected: x.expected, actual: x.actual });
  }
  return out;
}

// ---------- tools ----------

export const TOOLS = [
  {
    name: 'about',
    description: 'Who operates this server, why it exists, the ground rules (it never deletes, never points a phone number at a flow, never dials), the Amazon Connect vocabulary, the build playbook, and the VERIFIED API landmine list. Call this when you need context or before a first build.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    aws: false,
    handler: () => ABOUT,
  },
  {
    name: 'check_connection',
    description: 'Verify the Worker can reach Amazon Connect with its IAM credentials. Returns the region, the instance (alias, id, status, inbound/outbound enabled), object counts, and whether native test cases and outbound campaigns are available. Run this first if other tools fail: it separates bad credentials, a missing IAM permission, and an ambiguous instance.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const i = await cx.instanceId();
      const inst = (await cx.get(`/instance/${i}`)).Instance;
      const [flows, queues, hours, profiles] = await Promise.all([listFlows(cx), listQueues(cx), listHours(cx), listRoutingProfiles(cx)]);
      let testCases = 'available';
      try { await cx.get(`/test-case-executions/${i}`, { maxResults: 1 }); } catch (e) { testCases = `unavailable: ${e.message}`; }
      let campaigns;
      try { await cx.get(`/v2/connect-instance/${i}/config`, undefined, { service: 'connect-campaigns' }); campaigns = 'instance is onboarded to outbound campaigns'; } catch (e) { campaigns = `not onboarded (${e.type})`; }
      return {
        ok: true,
        region: cx.region,
        accessKey: `${cx.accessKeyId.slice(0, 4)}...${cx.accessKeyId.slice(-4)}${cx.sessionToken ? ' (temporary credentials)' : ''}`,
        instance: { alias: inst.InstanceAlias, id: inst.Id, arn: inst.Arn, status: inst.InstanceStatus, inboundCalls: inst.InboundCallsEnabled, outboundCalls: inst.OutboundCallsEnabled, accessUrl: inst.InstanceAccessUrl },
        counts: { flows: flows.length, queues: queues.length, hoursOfOperation: hours.length, routingProfiles: profiles.length },
        nativeTestCases: testCases,
        outboundCampaigns: campaigns,
      };
    },
  },
  {
    name: 'list_instances',
    description: 'List the Amazon Connect instances in this account and region (alias, id, status). If more than one exists, the server needs CONNECT_INSTANCE_ID to pick one.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const { entities } = await cx.listAll('/instance', 'InstanceSummaryList', {}, { pageSize: 10, max: 50 });
      return { region: cx.region, total: entities.length, instances: entities.map((x) => ({ alias: x.InstanceAlias, id: x.Id, status: x.InstanceStatus, inbound: x.InboundCallsEnabled, outbound: x.OutboundCallsEnabled })) };
    },
  },
  {
    name: 'contact_center_overview',
    description: 'One-call picture of the instance: hours of operation (with time zones), queues (with their hours), routing profiles, customer-facing flows (published or saved), phone numbers and which flow each one reaches, and user count. Run this FIRST before building so you reuse what exists.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const i = await cx.instanceId();
      const [hours, queues, profiles, flows, numbers, assoc, users] = await Promise.all([
        listHours(cx), listQueues(cx), listRoutingProfiles(cx), listFlows(cx, 'CONTACT_FLOW'), phoneNumbers(cx), phoneAssociations(cx),
        cx.listAll(`/users-summary/${i}`, 'UserSummaryList'),
      ]);
      const hoursDetails = await Promise.all(hours.map((h) => hoursDetail(cx, h.Id).catch(() => null)));
      const flowByArn = Object.fromEntries(flows.map((f) => [f.Arn, f.Name]));
      const flowFor = Object.fromEntries(assoc.map((a) => [a.ResourceId, a.FlowId]));
      return {
        hoursOfOperation: hours.map((h, k) => ({ name: h.Name, id: h.Id, timezone: hoursDetails[k]?.TimeZone, schedule: hoursDetails[k] ? configToSchedule(hoursDetails[k].Config) : undefined })),
        queues: queues.map(summarizeQueue),
        routingProfiles: profiles.map((p) => ({ name: p.Name, id: p.Id })),
        flows: flows.map((f) => ({ name: f.Name, id: f.Id, status: f.ContactFlowStatus, state: f.ContactFlowState })),
        phoneNumbers: numbers.map((n) => ({ number: n.PhoneNumber, id: n.PhoneNumberId, type: n.PhoneNumberType, flow: flowFor[n.PhoneNumberArn] ? (flowByArn[flowFor[n.PhoneNumberArn]] || flowFor[n.PhoneNumberArn]) : null })),
        users: users.entities.length,
        note: numbers.length ? undefined : 'No phone numbers are claimed in this instance, so nothing built here can receive a real call yet. Claiming a number and pointing it at a flow are human steps in the Connect console.',
      };
    },
  },

  // ----- flows -----
  {
    name: 'list_contact_flows',
    description: 'List flows (contact flows) in the instance with type, status (PUBLISHED/SAVED), and state. Filter by type (default CONTACT_FLOW, the inbound IVR type; pass "all" for every type) and/or a name search.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['CONTACT_FLOW', 'CUSTOMER_QUEUE', 'CUSTOMER_HOLD', 'CUSTOMER_WHISPER', 'AGENT_HOLD', 'AGENT_WHISPER', 'OUTBOUND_WHISPER', 'AGENT_TRANSFER', 'QUEUE_TRANSFER', 'CAMPAIGN', 'all'] },
        search: { type: 'string', description: 'Case-insensitive substring of the flow name' },
      },
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const type = a.type || 'CONTACT_FLOW';
      let rows = await listFlows(cx, type === 'all' ? undefined : type);
      if (a.search) rows = rows.filter((f) => f.Name.toLowerCase().includes(a.search.toLowerCase()));
      return { total: rows.length, flows: rows.map((f) => ({ name: f.Name, id: f.Id, type: f.ContactFlowType, status: f.ContactFlowStatus, state: f.ContactFlowState })) };
    },
  },
  {
    name: 'get_contact_flow',
    description: 'Get one flow by name or id: metadata, the phone numbers that currently reach it, and (by default) its Flow language JSON content.',
    inputSchema: {
      type: 'object',
      properties: {
        flow: { type: 'string', description: 'Flow name or id' },
        include_content: { type: 'boolean', description: 'Include the Flow language JSON (default true)' },
      },
      required: ['flow'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const f = await describeFlow(cx, a.flow);
      const [assoc, numbers] = await Promise.all([phoneAssociations(cx), phoneNumbers(cx)]);
      const wired = assoc.filter((x) => x.FlowId === f.Arn).map((x) => numbers.find((n) => n.PhoneNumberArn === x.ResourceId)?.PhoneNumber || x.ResourceId);
      const content = a.include_content === false ? undefined : JSON.parse(f.Content);
      return { name: f.Name, id: f.Id, arn: f.Arn, type: f.Type, status: f.Status, state: f.State, description: f.Description, phoneNumbers: wired, actions: content?.Actions?.length, content };
    },
  },
  {
    name: 'render_flow',
    description: 'Draw a flow as a Mermaid diagram for the chat. Pass `spec` (an IVR spec, before building: the preview to approve) or `flow` (name or id of an existing flow). For existing flows, detail "spec" (default) draws the clean menu-level view via export_flow_spec; "actions" draws every Flow language action and transition (faithful for any flow, including ones this server did not build). Show the user the diagram.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'object', description: 'IVR spec (same shape as build_flow)' },
        flow: { type: 'string', description: 'Existing flow name or id' },
        detail: { type: 'string', enum: ['spec', 'actions'] },
      },
      additionalProperties: false,
    },
    aws: 'optional',
    handler: async (cx, a) => {
      if (a.spec) {
        const v = validateSpec(a.spec);
        if (!v.ok) return { valid: false, errors: v.errors };
        return { valid: true, mermaid: specToMermaid(a.spec), gaps: v.gaps, note: 'Render the mermaid for the user; build_flow deploys it after they approve.' };
      }
      if (!a.flow) throw new ConnectError('Pass spec or flow.', 400, 'InvalidParameter');
      if (!cx) throw new ConnectError('Rendering an existing flow needs AWS credentials (open /setup).', 503, 'NotConfigured');
      const f = await describeFlow(cx, a.flow);
      if (a.detail === 'actions') return { flow: f.Name, detail: 'actions', mermaid: flowToMermaid(f.Content) };
      const ex = exportFlowSpec(f.Content, await exportContext(cx, f.Content), f.Name);
      return { flow: f.Name, detail: 'spec', mermaid: specToMermaid(ex.spec), gaps: ex.gaps, warnings: ex.warnings, note: ex.warnings.length ? 'Some actions have no spec equivalent; render with detail "actions" for the faithful view.' : undefined };
    },
  },
  {
    name: 'export_flow_spec',
    description: 'Read an existing flow back into the shared IVR spec (the same shape twilio-mcp\'s export_ivr_spec produces and build_flow accepts): greeting, hours (with the real schedule and time zone), menus, submenus, back-navigation, transfers by queue name, no-input handling, and option labels. Gaps (like voicemail) and actions with no spec equivalent are listed, never silently dropped.',
    inputSchema: {
      type: 'object',
      properties: { flow: { type: 'string', description: 'Flow name or id' } },
      required: ['flow'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const f = await describeFlow(cx, a.flow);
      const ex = exportFlowSpec(f.Content, await exportContext(cx, f.Content), f.Name);
      return { flow: f.Name, ...ex };
    },
  },
  {
    name: 'build_flow',
    description: 'Compile an IVR spec into Amazon Connect Flow language JSON, check it locally, and create it as a PUBLISHED flow (PUBLISHED is what makes Connect run its own server-side validation; any InvalidContactFlowException problems come back verbatim). The flow is inert until a human points a phone number at it. Spec: { name, language?, greeting?, hours?: { timezone, schedule: [{days, start, end}], closed?: {message?, then?} }, menu: { prompt, timeout_seconds?, options: [{ digit, label?, action }], no_input?: { retries?, message?, then? } } }. Actions: transfer_to_queue {queue, message?}, submenu {menu}, previous_menu, play_message {message, then?}, voicemail {message?} (GAP: no native block; compiled as hang up and reported), hangup. Max 3 menu levels. Queues (and the hours resource, if spec.hours is set) must exist: create_hours_of_operation / create_queue first. Show render_flow first and get ONE approval.',
    inputSchema: {
      type: 'object',
      properties: {
        spec: { type: 'object', description: 'The IVR spec' },
        name: { type: 'string', description: 'Flow name in Connect (default: spec.name)' },
        description: { type: 'string' },
        hours_of_operation: { type: 'string', description: 'Hours resource (name or id) for spec.hours. Default: "<flow name> Hours".' },
        queue_map: { type: 'object', description: 'Spec queue name -> Connect queue name or id, when they differ (e.g. {"Sales": "Inbound Sales"})' },
        replace: { type: 'boolean', description: 'If a flow with this name exists, overwrite its content. Refused if any phone number points at it (that would change a live line).' },
      },
      required: ['spec'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const i = await cx.instanceId();
      const spec = a.spec;
      const v = validateSpec(spec, { requireMenu: false });
      if (!v.ok) return { created: false, stage: 'spec validation', errors: v.errors };
      const flowName = String(a.name || spec.name).trim();

      // Resolve every queue the spec references, exactly.
      const queues = await listQueues(cx);
      const queueRefs = new Map();
      const unresolved = [];
      const collect = (act) => {
        if (!act) return;
        if (act.type === 'transfer_to_queue' && !queueRefs.has(act.queue)) {
          const target = a.queue_map?.[act.queue] ?? act.queue;
          try { queueRefs.set(act.queue, pick(queues, target, 'queue', { exact: true })); } catch (e) { unresolved.push(`${act.queue}: ${e.message}`); }
        }
        if (act.type === 'submenu') walkMenu(act.menu);
        if (act.type === 'play_message') collect(act.then);
      };
      const walkMenu = (m) => { for (const o of m?.options || []) collect(o.action); collect(m?.no_input?.then); };
      walkMenu(spec.menu);
      collect(spec.hours?.closed?.then);
      if (unresolved.length) return { created: false, stage: 'resolve queues', errors: unresolved, fix: 'create_queue for each missing queue (or pass queue_map), then build again.' };

      let hoursRow = null;
      if (spec.hours) {
        const ref = a.hours_of_operation || `${flowName} Hours`;
        try { hoursRow = pick(await listHours(cx), ref, 'hours of operation', { exact: true }); } catch (e) {
          return { created: false, stage: 'resolve hours', errors: [e.message], fix: `create_hours_of_operation with name "${ref}" and hours = spec.hours (or pass hours_of_operation).` };
        }
      }

      const { content, gaps, warnings } = compileFlow(spec, {
        queueArn: (n) => queueRefs.get(n).Arn,
        hoursArn: hoursRow?.Arn,
        hoursName: hoursRow?.Name,
      });
      const local = validateFlowContent(content);
      if (!local.ok) return { created: false, stage: 'local structural validation', errors: local.errors };

      const existing = (await listFlows(cx)).find((f) => f.Name.toLowerCase() === flowName.toLowerCase());
      let result;
      try {
        if (existing) {
          if (!a.replace) return { created: false, stage: 'name check', errors: [`A flow named "${existing.Name}" already exists (${existing.Id}). Pick a new name, or pass replace: true to overwrite its content.`] };
          const wired = (await phoneAssociations(cx)).filter((x) => x.FlowId === existing.Arn);
          if (wired.length) {
            return { created: false, stage: 'go-live guard', errors: [`Refused: ${wired.length} phone number(s) point at "${existing.Name}", so replacing its content changes a live line. Build under a new name, test it with run_flow_test, then a human repoints the number in the Connect console.`] };
          }
          await cx.post(`/contact-flows/${i}/${existing.Id}/content`, { Content: JSON.stringify(content) });
          result = { replaced: true, id: existing.Id, arn: existing.Arn };
        } else {
          const res = await cx.put(`/contact-flows/${i}`, {
            Name: flowName, Type: 'CONTACT_FLOW', Status: 'PUBLISHED', Content: JSON.stringify(content), Tags: TAGS,
            Description: a.description || `Built by amazon-connect-mcp from the ${spec.name} IVR spec.`,
          });
          result = { created: true, id: res.ContactFlowId, arn: res.ContactFlowArn };
        }
      } catch (e) {
        if (e.problems) {
          return { created: false, stage: 'Amazon Connect server-side validation (InvalidContactFlowException)', problems: e.problems.map((p) => p.message || p), note: 'These are Connect\'s own validation messages, verbatim. Nothing was saved.' };
        }
        throw e;
      }
      return {
        ...result,
        name: flowName,
        status: 'PUBLISHED',
        validation: 'passed Amazon Connect server-side validation (PUBLISHED)',
        actions: content.Actions.length,
        queues: Object.fromEntries([...queueRefs].map(([k, q]) => [k, q.Name])),
        hours: hoursRow?.Name,
        gaps,
        warnings: [...warnings, ...local.warnings],
        mermaid: specToMermaid(spec),
        live: 'No. No phone number points at this flow. Test it with run_flow_test; pointing a number at it is a human step in the Connect console.',
      };
    },
  },
  {
    name: 'run_flow_test',
    description: 'Prove a flow works with Amazon Connect\'s NATIVE testing and simulation: creates a test case that simulates a caller (no phone number, nothing dials), presses the given digits after hearing each prompt, and checks where the call lands; then runs it and returns Connect\'s verdict with a step-by-step transcript. Example: flow "Main_Line", digits ["2","1"], expect_queue "Support". By default, if the flow checks hours, the test substitutes an always-open hours resource so the result does not depend on the clock. Test cases are kept as receipts (this server never deletes).',
    inputSchema: {
      type: 'object',
      properties: {
        flow: { type: 'string', description: 'Flow name or id' },
        digits: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6, description: 'DTMF presses in order, e.g. ["2","1"]' },
        expect_queue: { type: 'string', description: 'Queue (name or id) the call must land in. Default: wherever the flow path says.' },
        hours: { type: 'string', enum: ['force_open', 'as_is'], description: 'force_open (default) substitutes an always-open hours resource during the test' },
        name_prefix: { type: 'string', description: 'Prefix for the test case name (e.g. MCP_Test_)' },
        wait_seconds: { type: 'integer', minimum: 0, maximum: 240, description: 'How long to wait for the verdict (default 120). 0 = start and return ids.' },
      },
      required: ['flow', 'digits'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const i = await cx.instanceId();
      const f = await describeFlow(cx, a.flow);
      const ctx = { ...(await exportContext(cx, f.Content)), includeRefs: true };
      const ex = exportFlowSpec(f.Content, ctx, f.Name);

      let expectQueue;
      if (a.expect_queue) {
        const q = pick(await listQueues(cx), a.expect_queue, 'queue', { exact: true });
        expectQueue = { name: q.Name, arn: q.Arn };
      }

      let hoursOverride;
      const notes = [];
      const content0 = JSON.parse(f.Content);
      const check = content0.Actions.find((x) => x.Type === 'CheckHoursOfOperation');
      if (check && (a.hours || 'force_open') === 'force_open') {
        const all = await listHours(cx);
        const details = await Promise.all(all.map((h) => hoursDetail(cx, h.Id).catch(() => null)));
        const open = details.find((h) => h && isAlwaysOpen(h.Config));
        if (open) {
          hoursOverride = { from: check.Parameters.HoursOfOperationId, to: open.HoursOfOperationArn };
          notes.push(`Hours forced open for the test by substituting "${open.Name}" (open 24/7).`);
        } else notes.push('No always-open hours resource exists to substitute, so the test runs against the real clock; outside business hours it takes the closed path.');
      }

      let built;
      try { built = buildTestContent({ spec: ex.spec, digits: a.digits.map(String), expectQueue, hoursOverride }); } catch (e) {
        throw new ConnectError(`Cannot simulate that path: ${e.message}`, 400, 'InvalidPath');
      }
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const prefix = a.name_prefix && !f.Name.startsWith(a.name_prefix) ? a.name_prefix : '';
      const testName = `${prefix}${f.Name} press ${a.digits.join(' ')} ${stamp}`.slice(0, 127);
      let tc;
      try {
        tc = await cx.put(`/test-cases/${i}`, {
          Name: testName,
          Description: `Simulated call through ${f.Name}: press ${a.digits.join(', ')}. Built by amazon-connect-mcp.`,
          Content: JSON.stringify(built.content),
          EntryPoint: { Type: 'VOICE_CALL', VoiceCallEntryPointParameters: { FlowId: f.Id } },
          Status: 'PUBLISHED',
          Tags: TAGS,
        });
      } catch (e) {
        if (e.problems) return { ran: false, stage: 'test case validation (InvalidTestCaseException)', problems: e.problems, content: built.content };
        throw e;
      }
      const exec = await cx.put(`/test-cases/${i}/${tc.TestCaseId}/start-execution`, { ClientToken: `amcp-${stamp}-${Math.random().toString(36).slice(2, 10)}` });
      const ids = { testCaseId: tc.TestCaseId, testCaseArn: tc.TestCaseArn, executionId: exec.TestCaseExecutionId, testCaseName: testName };
      const wait = a.wait_seconds ?? 120;
      const deadline = Date.now() + wait * 1000;
      let summary = { Status: exec.Status };
      while (wait > 0 && Date.now() < deadline && ['INITIATED', 'IN_PROGRESS'].includes(summary.Status)) {
        await sleep(3000);
        summary = await cx.get(`/test-cases/${i}/${tc.TestCaseId}/${exec.TestCaseExecutionId}/summary`);
      }
      const done = !['INITIATED', 'IN_PROGRESS'].includes(summary.Status);
      const records = done ? summarizeRecords((await cx.get(`/test-cases/${i}/${tc.TestCaseId}/${exec.TestCaseExecutionId}/records`, { maxResults: 100 })).ExecutionRecords) : undefined;
      return {
        verdict: summary.Status,
        passed: summary.Status === 'PASSED',
        flow: f.Name,
        path: a.digits,
        expected: built.expectation,
        observations: summary.ObservationSummary,
        failures: records ? failuresOf(records) : undefined,
        transcript: records?.steps,
        completion: records?.completion,
        simulatedContactId: records?.contactId,
        ...ids,
        notes: [...notes, ...(done ? [] : [`Still ${summary.Status}; call get_test_run with the ids to read the verdict.`])],
      };
    },
  },
  {
    name: 'get_test_run',
    description: 'Read the verdict and step-by-step transcript of a native test run started by run_flow_test (use when it returned before the run finished).',
    inputSchema: {
      type: 'object',
      properties: { test_case_id: { type: 'string' }, execution_id: { type: 'string' } },
      required: ['test_case_id', 'execution_id'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const i = await cx.instanceId();
      const id = String(a.test_case_id).split('/').pop();
      const s = await cx.get(`/test-cases/${i}/${id}/${a.execution_id}/summary`);
      const done = !['INITIATED', 'IN_PROGRESS'].includes(s.Status);
      const r = done ? summarizeRecords((await cx.get(`/test-cases/${i}/${id}/${a.execution_id}/records`, { maxResults: 100 })).ExecutionRecords) : undefined;
      return {
        verdict: s.Status, passed: s.Status === 'PASSED', observations: s.ObservationSummary, failures: r ? failuresOf(r) : undefined, transcript: r?.steps, completion: r?.completion,
        note: done ? undefined : 'A run waiting for an event that never happens (for example a prompt the flow does not play) stays IN_PROGRESS until Connect times it out, about 5 minutes (verified).',
      };
    },
  },
  {
    name: 'go_live_checklist',
    description: 'Pre-flight for putting a flow on a phone number: checks the flow is published, lists the queues it transfers to and whether each is staffed (a routing profile includes it), shows the instance\'s phone numbers and what each reaches today. READ ONLY: this server never points a number at a flow. Use it when the user asks to go live, then tell them the exact console steps.',
    inputSchema: {
      type: 'object',
      properties: { flow: { type: 'string', description: 'Flow name or id' } },
      required: ['flow'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const i = await cx.instanceId();
      const f = await describeFlow(cx, a.flow);
      const content = JSON.parse(f.Content);
      const queueArns = [...new Set(content.Actions.filter((x) => x.Type === 'UpdateContactTargetQueue').map((x) => x.Parameters?.QueueId))];
      const queues = await listQueues(cx);
      const profiles = await listRoutingProfiles(cx);
      const staffed = new Map();
      for (const p of profiles) {
        const qs = (await cx.listAll(`/routing-profiles/${i}/${p.Id}/queues`, 'RoutingProfileQueueConfigSummaryList')).entities;
        if (!qs.some((q) => queueArns.includes(q.QueueArn))) continue;
        const users = (await cx.get(`/routing-profiles/${i}/${p.Id}`)).RoutingProfile?.NumberOfAssociatedUsers ?? 0;
        for (const q of qs) staffed.set(q.QueueArn, [...(staffed.get(q.QueueArn) || []), { routingProfile: p.Name, agents: users }]);
      }
      const [numbers, assoc, flows] = await Promise.all([phoneNumbers(cx), phoneAssociations(cx), listFlows(cx)]);
      const flowByArn = Object.fromEntries(flows.map((x) => [x.Arn, x.Name]));
      return {
        flow: { name: f.Name, id: f.Id, status: f.Status, published: f.Status === 'PUBLISHED' },
        queues: queueArns.map((arn) => {
          const rps = staffed.get(arn) || [];
          const agents = rps.reduce((n, r) => n + r.agents, 0);
          return { queue: queues.find((q) => q.Arn === arn)?.Name || arn, routingProfiles: rps, agents, staffed: agents > 0, ...(agents ? {} : { warning: rps.length ? 'In a routing profile, but no users are on it: callers would wait with nobody to answer.' : 'No routing profile includes this queue: nobody can answer it.' }) };
        }),
        phoneNumbers: numbers.map((n) => ({ number: n.PhoneNumber, reachesToday: flowByArn[assoc.find((x) => x.ResourceId === n.PhoneNumberArn)?.FlowId] || null })),
        checklist: GO_LIVE_CHECKLIST,
        thisServer: 'Will not point a number at the flow, on purpose (AssociatePhoneNumberContactFlow and AssociateFlow are refused in code and denied in the shipped IAM policy). A human presses go.',
      };
    },
  },

  // ----- hours -----
  {
    name: 'list_hours_of_operation',
    description: 'List hours of operation resources (name, id, time zone, schedule).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const rows = await listHours(cx);
      const details = await Promise.all(rows.map((h) => hoursDetail(cx, h.Id).catch(() => null)));
      return { total: rows.length, hours: rows.map((h, k) => ({ name: h.Name, id: h.Id, timezone: details[k]?.TimeZone, schedule: details[k] ? configToSchedule(details[k].Config) : undefined, alwaysOpen: details[k] ? isAlwaysOpen(details[k].Config) : undefined })) };
    },
  },
  {
    name: 'get_hours_of_operation',
    description: 'Get one hours of operation resource by name or id, with its schedule in the shared spec shape ({timezone, schedule:[{days,start,end}]}).',
    inputSchema: { type: 'object', properties: { hours: { type: 'string', description: 'Name or id' } }, required: ['hours'], additionalProperties: false },
    handler: async (cx, a) => {
      const row = pick(await listHours(cx), a.hours, 'hours of operation');
      const h = await hoursDetail(cx, row.Id);
      return { name: h.Name, id: h.HoursOfOperationId, arn: h.HoursOfOperationArn, description: h.Description, spec: { timezone: h.TimeZone, schedule: configToSchedule(h.Config) }, alwaysOpen: isAlwaysOpen(h.Config) };
    },
  },
  {
    name: 'create_hours_of_operation',
    description: 'Create an hours of operation resource from the shared spec\'s hours shape: { timezone: "America/New_York", schedule: [{ days: ["monday",...], start: "08:00", end: "18:00" }] } (end "24:00" = midnight; days not listed are closed). If one with this exact name exists, it is returned instead (nothing is overwritten).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        hours: { type: 'object', description: '{ timezone, schedule: [{days, start, end}] } (closed is ignored here; it belongs to the flow)' },
        description: { type: 'string' },
      },
      required: ['name', 'hours'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const i = await cx.instanceId();
      let config;
      try { config = specHoursToConfig(a.hours); } catch (e) { throw new ConnectError(e.message, 400, 'InvalidParameter'); }
      const existing = (await listHours(cx)).find((h) => h.Name.toLowerCase() === a.name.trim().toLowerCase());
      if (existing) return { created: false, alreadyExisted: true, name: existing.Name, id: existing.Id, arn: existing.Arn, note: 'An hours resource with this name already exists; returned as-is (nothing overwritten).' };
      const res = await cx.put(`/hours-of-operations/${i}`, { Name: a.name.trim(), Description: a.description || 'Built by amazon-connect-mcp.', TimeZone: a.hours.timezone, Config: config, Tags: TAGS });
      return { created: true, name: a.name.trim(), id: res.HoursOfOperationId, arn: res.HoursOfOperationArn, timezone: a.hours.timezone, schedule: configToSchedule(config) };
    },
  },

  // ----- queues -----
  {
    name: 'list_queues',
    description: 'List standard queues (name, id). Optional name search.',
    inputSchema: { type: 'object', properties: { search: { type: 'string' } }, additionalProperties: false },
    handler: async (cx, a) => {
      let rows = await listQueues(cx);
      if (a.search) rows = rows.filter((q) => q.Name.toLowerCase().includes(a.search.toLowerCase()));
      return { total: rows.length, queues: rows.map(summarizeQueue) };
    },
  },
  {
    name: 'get_queue',
    description: 'Get one queue by name or id: status, hours of operation (by name), max contacts, outbound caller config.',
    inputSchema: { type: 'object', properties: { queue: { type: 'string' } }, required: ['queue'], additionalProperties: false },
    handler: async (cx, a) => {
      const i = await cx.instanceId();
      const row = pick(await listQueues(cx), a.queue, 'queue');
      const q = (await cx.get(`/queues/${i}/${row.Id}`)).Queue;
      const hours = (await listHours(cx)).find((h) => h.Id === q.HoursOfOperationId);
      return { name: q.Name, id: q.QueueId, arn: q.QueueArn, status: q.Status, description: q.Description, hoursOfOperation: hours?.Name || q.HoursOfOperationId, maxContacts: q.MaxContacts, outboundCallerConfig: q.OutboundCallerConfig };
    },
  },
  {
    name: 'create_queue',
    description: 'Create a standard queue. Requires an hours of operation resource (name or id). Optional: description, max_contacts, outbound caller ID name, and an outbound caller ID number (a number already claimed in this instance, by E.164 or id). If a queue with this exact name exists, it is returned instead.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        hours_of_operation: { type: 'string', description: 'Hours resource name or id' },
        description: { type: 'string' },
        max_contacts: { type: 'integer', minimum: 1, maximum: 10000 },
        outbound_caller_id_name: { type: 'string' },
        outbound_caller_id_number: { type: 'string', description: 'E.164 number or phone number id claimed in this instance' },
      },
      required: ['name', 'hours_of_operation'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const i = await cx.instanceId();
      const existing = (await listQueues(cx)).find((q) => q.Name.toLowerCase() === a.name.trim().toLowerCase());
      if (existing) return { created: false, alreadyExisted: true, ...summarizeQueue(existing), note: 'A queue with this name already exists; returned as-is (nothing overwritten).' };
      const hours = pick(await listHours(cx), a.hours_of_operation, 'hours of operation', { exact: true });
      const body = { Name: a.name.trim(), Description: a.description || 'Built by amazon-connect-mcp.', HoursOfOperationId: hours.Id, Tags: TAGS };
      if (a.max_contacts) body.MaxContacts = a.max_contacts;
      if (a.outbound_caller_id_name || a.outbound_caller_id_number) {
        body.OutboundCallerConfig = {};
        if (a.outbound_caller_id_name) body.OutboundCallerConfig.OutboundCallerIdName = a.outbound_caller_id_name;
        if (a.outbound_caller_id_number) {
          const nums = await phoneNumbers(cx);
          const n = nums.find((x) => x.PhoneNumberId === a.outbound_caller_id_number || x.PhoneNumber === a.outbound_caller_id_number);
          if (!n) throw new ConnectError(`"${a.outbound_caller_id_number}" is not a phone number claimed in this instance (claiming numbers is a human step in the Connect console).`, 404, 'NotFound');
          body.OutboundCallerConfig.OutboundCallerIdNumberId = n.PhoneNumberId;
        }
      }
      const res = await cx.put(`/queues/${i}`, body);
      return { created: true, name: body.Name, id: res.QueueId, arn: res.QueueArn, hoursOfOperation: hours.Name };
    },
  },

  // ----- routing profiles -----
  {
    name: 'list_routing_profiles',
    description: 'List routing profiles (name, id).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const rows = await listRoutingProfiles(cx);
      return { total: rows.length, routingProfiles: rows.map((p) => ({ name: p.Name, id: p.Id })) };
    },
  },
  {
    name: 'get_routing_profile',
    description: 'Get one routing profile by name or id: media concurrency per channel, default outbound queue, and its queues with priority and delay.',
    inputSchema: { type: 'object', properties: { routing_profile: { type: 'string' } }, required: ['routing_profile'], additionalProperties: false },
    handler: async (cx, a) => {
      const i = await cx.instanceId();
      const row = pick(await listRoutingProfiles(cx), a.routing_profile, 'routing profile');
      const p = (await cx.get(`/routing-profiles/${i}/${row.Id}`)).RoutingProfile;
      const qs = (await cx.listAll(`/routing-profiles/${i}/${row.Id}/queues`, 'RoutingProfileQueueConfigSummaryList')).entities;
      return {
        name: p.Name, id: p.RoutingProfileId, arn: p.RoutingProfileArn, description: p.Description, isDefault: p.IsDefault,
        mediaConcurrency: Object.fromEntries((p.MediaConcurrencies || []).map((m) => [m.Channel, m.Concurrency])),
        defaultOutboundQueueId: p.DefaultOutboundQueueId, users: p.NumberOfAssociatedUsers,
        queues: qs.map((q) => ({ queue: q.QueueName, channel: q.Channel, priority: q.Priority, delay: q.Delay })),
      };
    },
  },
  {
    name: 'create_routing_profile',
    description: 'Create a routing profile: which queues agents on it take calls from (priority 1 = first, delay in seconds), how many contacts at once per channel (media concurrency, e.g. { voice: 1, chat: 2 }), and the default outbound queue (default: the first queue). If one with this exact name exists, it is returned instead. Assigning users to it is a human step (no user writes here).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        queues: {
          type: 'array', minItems: 1, maxItems: 10,
          items: { type: 'object', properties: { queue: { type: 'string' }, priority: { type: 'integer', minimum: 1, maximum: 99 }, delay: { type: 'integer', minimum: 0, maximum: 9999 }, channel: { type: 'string', enum: ['VOICE', 'CHAT', 'TASK'] } }, required: ['queue'], additionalProperties: false },
        },
        media: { type: 'object', description: 'Concurrency per channel, e.g. { "voice": 1, "chat": 2, "task": 0 } (default voice 1)' },
        default_outbound_queue: { type: 'string', description: 'Queue name or id (default: the first queue)' },
      },
      required: ['name', 'queues'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      const i = await cx.instanceId();
      const existing = (await listRoutingProfiles(cx)).find((p) => p.Name.toLowerCase() === a.name.trim().toLowerCase());
      if (existing) return { created: false, alreadyExisted: true, name: existing.Name, id: existing.Id, arn: existing.Arn, note: 'A routing profile with this name already exists; returned as-is (nothing overwritten).' };
      const queues = await listQueues(cx);
      const configs = a.queues.map((q) => {
        const row = pick(queues, q.queue, 'queue', { exact: true });
        return { row, cfg: { QueueReference: { QueueId: row.Id, Channel: q.channel || 'VOICE' }, Priority: q.priority ?? 1, Delay: q.delay ?? 0 } };
      });
      const media = { voice: 1, ...(a.media || {}) };
      const MediaConcurrencies = Object.entries(media).filter(([, n]) => Number(n) > 0).map(([ch, n]) => {
        const Channel = String(ch).toUpperCase();
        if (!['VOICE', 'CHAT', 'TASK', 'EMAIL'].includes(Channel)) throw new ConnectError(`Unknown channel "${ch}" in media (use voice, chat, task, email).`, 400, 'InvalidParameter');
        return { Channel, Concurrency: Number(n) };
      });
      const outbound = a.default_outbound_queue ? pick(queues, a.default_outbound_queue, 'queue', { exact: true }) : configs[0].row;
      const res = await cx.put(`/routing-profiles/${i}`, {
        Name: a.name.trim(), Description: a.description || 'Built by amazon-connect-mcp.', DefaultOutboundQueueId: outbound.Id,
        QueueConfigs: configs.map((c) => c.cfg), MediaConcurrencies, Tags: TAGS,
      });
      return { created: true, name: a.name.trim(), id: res.RoutingProfileId, arn: res.RoutingProfileArn, queues: configs.map((c) => ({ queue: c.row.Name, priority: c.cfg.Priority, delay: c.cfg.Delay, channel: c.cfg.QueueReference.Channel })), mediaConcurrency: Object.fromEntries(MediaConcurrencies.map((m) => [m.Channel, m.Concurrency])), defaultOutboundQueue: outbound.Name };
    },
  },

  // ----- numbers, prompts, users (read) -----
  {
    name: 'list_phone_numbers',
    description: 'List phone numbers claimed in the instance and the flow each one reaches (the go-live wiring). READ ONLY: claiming, releasing, and repointing numbers are human steps.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const [numbers, assoc, flows] = await Promise.all([phoneNumbers(cx), phoneAssociations(cx), listFlows(cx)]);
      const flowByArn = Object.fromEntries(flows.map((f) => [f.Arn, f.Name]));
      return {
        total: numbers.length,
        phoneNumbers: numbers.map((n) => {
          const fa = assoc.find((x) => x.ResourceId === n.PhoneNumberArn)?.FlowId;
          return { number: n.PhoneNumber, id: n.PhoneNumberId, type: n.PhoneNumberType, country: n.PhoneNumberCountryCode, description: n.PhoneNumberDescription, flow: fa ? (flowByArn[fa] || fa) : null };
        }),
      };
    },
  },
  {
    name: 'list_prompts',
    description: 'List audio prompts in the instance (name, id).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const i = await cx.instanceId();
      const { entities } = await cx.listAll(`/prompts-summary/${i}`, 'PromptSummaryList');
      return { total: entities.length, prompts: entities.map((p) => ({ name: p.Name, id: p.Id })) };
    },
  },
  {
    name: 'list_users',
    description: 'List users (agents and admins) by username and id. READ ONLY.',
    inputSchema: { type: 'object', properties: { search: { type: 'string' } }, additionalProperties: false },
    handler: async (cx, a) => {
      const i = await cx.instanceId();
      let { entities } = await cx.listAll(`/users-summary/${i}`, 'UserSummaryList');
      if (a.search) entities = entities.filter((u) => u.Username.toLowerCase().includes(a.search.toLowerCase()));
      return { total: entities.length, users: entities.map((u) => ({ username: u.Username, id: u.Id })) };
    },
  },
  {
    name: 'get_user',
    description: 'Get one user by username or id: name, email, routing profile (by name), phone type. READ ONLY (no user or security profile writes here).',
    inputSchema: { type: 'object', properties: { user: { type: 'string' } }, required: ['user'], additionalProperties: false },
    handler: async (cx, a) => {
      const i = await cx.instanceId();
      const { entities } = await cx.listAll(`/users-summary/${i}`, 'UserSummaryList');
      const row = pick(entities.map((u) => ({ ...u, Name: u.Username })), a.user, 'user');
      const u = (await cx.get(`/users/${i}/${row.Id}`)).User;
      const rp = (await listRoutingProfiles(cx)).find((p) => p.Id === u.RoutingProfileId);
      return redactSecrets({ username: u.Username, id: u.Id, firstName: u.IdentityInfo?.FirstName, lastName: u.IdentityInfo?.LastName, email: u.IdentityInfo?.Email, routingProfile: rp?.Name || u.RoutingProfileId, phoneType: u.PhoneConfig?.PhoneType, securityProfiles: (u.SecurityProfileIds || []).length });
    },
  },

  // ----- outbound (read in v0.1) -----
  {
    name: 'outbound_readiness',
    description: 'Is this instance ready for outbound campaigns (Amazon Connect outbound campaigns v2)? Reports whether the instance is onboarded to campaigns and lists this instance\'s campaigns with their state. READ ONLY in v0.1: campaign creation ships in v0.2, and no tool here can start or resume a campaign.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (cx) => {
      const i = await cx.instanceId();
      let onboarded = false;
      let detail;
      try { detail = (await cx.get(`/v2/connect-instance/${i}/config`, undefined, { service: 'connect-campaigns' })).connectInstanceConfig; onboarded = true; } catch (e) { detail = e.message; }
      let campaigns = [];
      try {
        const res = await cx.post('/v2/campaigns-summary', { maxResults: 50, filters: { instanceIdFilter: { value: i, operator: 'Eq' } } }, { service: 'connect-campaigns' });
        campaigns = (res.campaignSummaryList || []).map((c) => ({ name: c.name, id: c.id, channels: c.channelSubtypes }));
      } catch (e) { campaigns = `could not list: ${e.message}`; }
      return {
        onboarded,
        detail,
        campaigns,
        v01: 'create_outbound_campaign is v0.2. On an instance that is not onboarded, CreateCampaign answers "Connect Instance does not exist or is not enabled to use Campaigns" (verified). Onboarding (encryption config) is a human step in the Connect console.',
      };
    },
  },

  // ----- power tool -----
  {
    name: 'connect_api_call',
    description: 'Call an Amazon Connect API directly, for reads without a typed tool. Runs on an ALLOWLIST: reads of instances, flows, flow modules, hours, queues, routing profiles (and their queues), phone numbers, flow associations, prompts, users, test cases and executions, campaigns (read), plus the same creates the typed tools do (hours, queues, routing profiles, flows, test cases). Always refused: any DELETE, AssociatePhoneNumberContactFlow / AssociateFlow (go-live), UpdatePhoneNumber, claiming/releasing/importing numbers, every live-contact API (Start*Contact, StartOutboundVoiceContact, transfer, stop), campaign start/resume/outbound requests, and user, security profile, and instance writes. Paths are absolute with ids, not ARNs (e.g. /queues-summary/<instance-id>); no %, ?, #, ;, \\, or dot segments; query params go in `query`. The host is pinned to connect.<region>.amazonaws.com (service "connect") or connect-campaigns.<region>.amazonaws.com. Secrets are redacted. Treat any non-GET as a write and confirm with the user first.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'PUT', 'POST'] },
        path: { type: 'string', description: 'Absolute path, e.g. "/queues-summary/<instance-id>" ("{instance}" is replaced with the configured instance id)' },
        query: { type: 'object', description: 'Query parameters: identifier keys, scalar values' },
        body: { type: 'object', description: 'JSON body for PUT/POST' },
        service: { type: 'string', enum: ['connect', 'connect-campaigns'] },
      },
      required: ['method', 'path'],
      additionalProperties: false,
    },
    handler: async (cx, a) => {
      let path = String(a.path);
      if (path.includes('{instance}')) path = path.split('{instance}').join(await cx.instanceId());
      const c = checkRawCall({ ...a, path, service: a.service || 'connect' });
      if (!c.ok) throw new ConnectError(c.message, 403, 'Refused');
      const res = await cx.request(c.method, c.path, { query: c.query, body: c.method === 'GET' ? undefined : (a.body ?? {}), service: c.service });
      return redactSecrets(res);
    },
  },
];

// ---------- registry plumbing ----------

export function toolDefs() {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export function makeClient(cfg) {
  return new ConnectClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, sessionToken: cfg.sessionToken, region: cfg.region, instanceId: cfg.instanceId });
}

export async function callTool(cfg, name, args = {}) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const errors = validateArgs(tool.inputSchema, args ?? {});
  if (errors.length) throw new ConnectError(`Invalid arguments: ${errors.join('; ')}`, 400, 'InvalidArguments');
  if (tool.aws === false) return tool.handler(null, args ?? {}, cfg);
  if (!cfg.configured) {
    if (tool.aws === 'optional') return tool.handler(null, args ?? {}, cfg);
    throw new ConnectError('This server is not connected to Amazon Connect yet - open /setup, or set the AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION secrets.', 503, 'NotConfigured');
  }
  return tool.handler(makeClient(cfg), args ?? {}, cfg);
}

// UI metadata - which tools are writes, and how they group on the landing page.
export const WRITE_TOOLS = new Set([
  'build_flow', 'run_flow_test', 'create_hours_of_operation', 'create_queue', 'create_routing_profile', 'connect_api_call',
]);

export const TOOL_GROUPS = [
  { name: 'Instance & Connection', icon: '🔌', tools: ['about', 'check_connection', 'list_instances', 'contact_center_overview'] },
  { name: 'Flows (IVR Builder)', icon: '🏗️', tools: ['list_contact_flows', 'get_contact_flow', 'render_flow', 'build_flow', 'export_flow_spec'] },
  { name: 'Native Testing', icon: '🧪', tools: ['run_flow_test', 'get_test_run', 'go_live_checklist'] },
  { name: 'Hours & Queues', icon: '🕐', tools: ['list_hours_of_operation', 'get_hours_of_operation', 'create_hours_of_operation', 'list_queues', 'get_queue', 'create_queue'] },
  { name: 'Routing & People', icon: '👥', tools: ['list_routing_profiles', 'get_routing_profile', 'create_routing_profile', 'list_users', 'get_user'] },
  { name: 'Numbers, Prompts & Outbound', icon: '📇', tools: ['list_phone_numbers', 'list_prompts', 'outbound_readiness'] },
  { name: 'Power', icon: '⚡', tools: ['connect_api_call'] },
];
