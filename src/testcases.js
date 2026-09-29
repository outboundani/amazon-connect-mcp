// Native testing and simulation: builds a Connect test case (the Connect
// Customer Testing language, Version 2019-10-30) that simulates a caller
// walking a digit path through a flow, and summarizes execution records.
//
// Verified live (see about.js landmines):
//   - a VOICE_CALL test needs only a FlowId entry point: no phone number,
//     nothing dials, and the "caller" is a simulated contact
//   - prompts come back as ASR transcripts of the TTS ("press one" for
//     "press 1"), so MessageReceived uses Similarity matching, not Inclusion
//   - StartTestCaseExecution returns TestCaseId as the full ARN, not the id
//   - records are JSON strings in ExecutionRecords[].Record, with a
//     RecordType (INITIATION, EXECUTION_START, OBSERVATION, COMPLETION) the
//     API reference does not list

import { walkSpec } from './flows.js';

export const TEST_VERSION = '2019-10-30';

const obsId = (s) => String(s).replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 60);

// opts: { spec (exported, with queue_arn refs), digits, expectQueue?: {name, arn},
//         hoursOverride?: { from: arn, to: arn } }
export function buildTestContent({ spec, digits, expectQueue, hoursOverride }) {
  const walk = walkSpec(spec, digits);
  const observations = [];
  const push = (o) => {
    if (observations.length) observations[observations.length - 1].Transitions = { NextObservations: [o.Identifier] };
    observations.push({ ...o, Transitions: { NextObservations: [] } });
  };
  const hear = (id, text) => ({ Identifier: `evt-${id}`, Type: 'MessageReceived', Actor: 'System', Properties: { Text: text, MatchingCriteria: { Type: 'Similarity' } } });
  const endTest = (id) => ({ Identifier: id, Type: 'TestControl', Parameters: { ActionType: 'TestControl', Command: { Type: 'EndTest' } }, Transitions: {} });

  if (hoursOverride?.from && hoursOverride?.to) {
    push({
      Identifier: 'Force hours open',
      Event: { Identifier: 'evt-start', Type: 'TestInitiated', Actor: 'System', Properties: {} },
      Actions: [{
        Identifier: 'substitute-hours',
        Type: 'OverrideSystemBehavior',
        Parameters: {
          ActionType: 'OverrideSystemBehavior',
          Behavior: {
            Type: 'FlowAction',
            Properties: {
              ActionType: 'CheckHoursOfOperation',
              ActionParameters: { HoursOfOperationId: hoursOverride.from },
              Strategy: { Type: 'SubstituteResource', SubstituteArn: hoursOverride.to },
            },
          },
        },
        Transitions: {},
      }],
    });
  }

  let step = 0;
  for (let i = 0; i < walk.steps.length; i++) {
    const s = walk.steps[i];
    if (s.kind !== 'hear') continue;
    step++;
    const next = walk.steps[i + 1];
    const actions = [];
    if (next?.kind === 'press') {
      actions.push({ Identifier: `press-${step}`, Type: 'SendInstruction', Parameters: { ActionType: 'SendInstruction', Actor: 'Customer', Instruction: { Type: 'DtmfInput', Properties: { Value: next.digit } } }, Transitions: {} });
    }
    push({ Identifier: obsId(`${step} ${s.what === 'greeting' ? 'Greeting' : `Menu then press ${next?.digit ?? ''}`}`), Event: hear(step, s.text), Actions: actions });
  }

  const end = walk.end;
  const expectation = {};
  if (end.type === 'transfer_to_queue') {
    // The event follows the path the flow actually defines (so it fires);
    // the assertion carries the caller's expectation (so a wrong queue fails
    // fast instead of waiting for a transfer that never happens).
    const actual = { name: end.queue_name || end.queue, arn: end.queue_arn };
    const q = expectQueue || actual;
    expectation.queue = q.name;
    if (end.message) { step++; push({ Identifier: obsId(`${step} Transfer message`), Event: hear(step, end.message), Actions: [] }); }
    push({
      Identifier: obsId(`Transfer then check queue is ${q.name}`),
      // FlowActionStarted requires ActionParameters.QueueId (verified: omitting
      // it is InvalidFlowActionParametersProblem).
      Event: { Identifier: 'evt-transfer', Type: 'FlowActionStarted', Actor: 'System', Properties: { ActionType: 'TransferContactToQueue', ActionParameters: { QueueId: actual.arn } } },
      Actions: [
        { Identifier: 'assert-queue', Type: 'Assert', Parameters: { Namespace: '$.Queue.Name', Operator: 'Equals', Operand: q.name }, Transitions: { NextAction: 'end' } },
        endTest('end'),
      ],
    });
  } else if (end.type === 'play_message') {
    step++;
    push({ Identifier: obsId(`${step} Message`), Event: hear(step, end.message), Actions: [endTest('end')] });
    expectation.message = end.message;
  } else if (end.type === 'menu') {
    step++;
    push({ Identifier: obsId(`${step} Menu reached`), Event: hear(step, end.menu.prompt), Actions: [endTest('end')] });
    expectation.menu = end.menu.prompt;
  } else {
    expectation.ends = end.type; // hangup / voicemail: the contact disconnects after the last press
  }

  return {
    content: { Version: TEST_VERSION, Metadata: { generator: 'amazon-connect-mcp' }, Observations: observations },
    walk,
    expectation,
  };
}

// ExecutionRecords -> a compact, model-friendly transcript.
export function summarizeRecords(records = []) {
  const steps = [];
  let completion = null;
  let contactId = null;
  for (const r of records) {
    let rec = {};
    try { rec = typeof r.Record === 'string' ? JSON.parse(r.Record) : (r.Record || {}); } catch { rec = {}; }
    const type = r.RecordType || rec.Type;
    if (type === 'EXECUTION_START') contactId = rec.ContactId || contactId;
    if (type === 'COMPLETION') {
      completion = { status: r.Status, reason: rec.CompletionReason?.Message, failureReasons: rec.CompletionReason?.FailureReasons || [], durationMs: rec.ExecutionSummary?.ExecutionDurationMs, summary: rec.ExecutionSummary };
    }
    if (type !== 'OBSERVATION') continue;
    const p = rec.Event?.Properties || {};
    steps.push({
      step: r.ObservationId,
      status: r.Status,
      event: rec.Event?.Type,
      heard: p.Text,
      expected: p.ExpectedText,
      flowAction: p.ActionType ? { type: p.ActionType, queue: p.ActionParameters?.QueueId } : undefined,
      actions: (rec.Actions || []).map((a) => (a.Type === 'Assert'
        // Quirk: an Assert's ActualParameters.Namespace holds the RESOLVED
        // value (e.g. the real queue name), not the JSONPath.
        ? { id: a.Identifier, type: 'Assert', status: a.Status, check: `${a.ExpectedParameters?.Namespace} ${a.ExpectedParameters?.Operator} ${a.ExpectedParameters?.Operand}`, actualValue: a.ActualParameters?.Namespace }
        : { id: a.Identifier, type: a.Type, status: a.Status, expected: a.ExpectedParameters, actual: a.ActualParameters })),
    });
  }
  return { contactId, steps, completion };
}
