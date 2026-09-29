import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  validateSpec, compileFlow, validateFlowContent, exportFlowSpec, normalizeSpec, specToMermaid, flowToMermaid,
  specHoursToConfig, configToSchedule, isAlwaysOpen, walkSpec, GAPS,
} from '../src/flows.js';
import { buildTestContent, summarizeRecords } from '../src/testcases.js';

const MAIN_LINE = JSON.parse(readFileSync(new URL('./fixtures/main_line.json', import.meta.url), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));
const QARN = (n) => `arn:aws:connect:us-east-1:111122223333:instance/00000000-0000-0000-0000-000000000000/queue/${n}`;
const HARN = 'arn:aws:connect:us-east-1:111122223333:instance/00000000-0000-0000-0000-000000000000/operating-hours/h1';
const ctx = { queueArn: QARN, hoursArn: HARN, hoursName: 'Main_Line Hours' };
const exportCtx = (spec) => ({
  queueNameByArn: {},
  hours: { [HARN]: { name: 'Main_Line Hours', timezone: spec.hours.timezone, schedule: configToSchedule(specHoursToConfig(spec.hours)) } },
});

test('the launch plan example spec validates, with voicemail declared as a gap', () => {
  const v = validateSpec(MAIN_LINE);
  assert.equal(v.ok, true, v.errors.join('; '));
  assert.deepEqual(v.gaps, [GAPS.voicemail]);
});

test('compile: Main_Line produces structurally valid Flow language', () => {
  const { content, gaps } = compileFlow(MAIN_LINE, ctx);
  assert.equal(content.Version, '2019-10-30');
  const v = validateFlowContent(content);
  assert.deepEqual(v.errors, []);
  assert.deepEqual(v.warnings, []);
  assert.deepEqual(gaps, [GAPS.voicemail]);
  const types = content.Actions.map((a) => a.Type);
  for (const t of ['UpdateContactTextToSpeechVoice', 'CheckHoursOfOperation', 'MessageParticipant', 'GetParticipantInput', 'UpdateContactTargetQueue', 'TransferContactToQueue', 'DisconnectParticipant']) assert.ok(types.includes(t), t);
  assert.equal(content.StartAction, 'Set voice');
  assert.equal(content.Actions.find((a) => a.Type === 'UpdateContactTextToSpeechVoice').Parameters.TextToSpeechVoice, 'Joanna');
});

test('compile: menus branch on DTMF Conditions and declare the three required errors', () => {
  const { content } = compileFlow(MAIN_LINE, ctx);
  const gpis = content.Actions.filter((a) => a.Type === 'GetParticipantInput');
  assert.equal(gpis.length, 6); // 2 menus x (retries 2 + 1)
  for (const g of gpis) {
    assert.deepEqual(g.Transitions.Errors.map((e) => e.ErrorType).sort(), ['InputTimeLimitExceeded', 'NoMatchingCondition', 'NoMatchingError']);
    for (const c of g.Transitions.Conditions) assert.equal(c.Condition.Operator, 'Equals');
  }
  const main = content.Actions.find((a) => a.Identifier === 'Main menu try 1');
  assert.deepEqual(main.Transitions.Conditions.map((c) => c.Condition.Operands[0]), ['1', '2', '3']);
});

test('compile: transfer_to_queue is UpdateContactTargetQueue (ARN) then TransferContactToQueue', () => {
  const { content } = compileFlow(MAIN_LINE, ctx);
  const by = new Map(content.Actions.map((a) => [a.Identifier, a]));
  const main = by.get('Main menu try 1');
  const sales = by.get(main.Transitions.Conditions[0].NextAction);
  assert.equal(sales.Type, 'MessageParticipant');
  assert.equal(sales.Parameters.Text, 'Connecting you to sales.');
  const setQ = by.get(sales.Transitions.NextAction);
  assert.equal(setQ.Type, 'UpdateContactTargetQueue');
  assert.equal(setQ.Parameters.QueueId, QARN('Sales'));
  const xfer = by.get(setQ.Transitions.NextAction);
  assert.equal(xfer.Type, 'TransferContactToQueue');
  assert.deepEqual(xfer.Parameters, {});
  assert.deepEqual(xfer.Transitions.Errors.map((e) => e.ErrorType).sort(), ['NoMatchingError', 'QueueAtCapacity']);
});

test('compile: previous_menu jumps back to the parent menu\'s first attempt', () => {
  const { content } = compileFlow(MAIN_LINE, ctx);
  const sub = content.Actions.find((a) => a.Identifier === 'Menu 2 try 1');
  const back = sub.Transitions.Conditions.find((c) => c.Condition.Operands[0] === '9');
  assert.equal(back.NextAction, 'Main menu try 1');
});

test('compile: hours check branches True/False and closed voicemail becomes a marked hang up', () => {
  const { content } = compileFlow(MAIN_LINE, ctx);
  const by = new Map(content.Actions.map((a) => [a.Identifier, a]));
  const h = by.get('Hours check');
  assert.equal(h.Parameters.HoursOfOperationId, HARN);
  assert.deepEqual(h.Transitions.Conditions.map((c) => c.Condition.Operands[0]), ['True', 'False']);
  const closed = by.get(h.Transitions.Conditions[1].NextAction);
  assert.equal(closed.Parameters.Text, "We're closed right now.");
  const vm = by.get(closed.Transitions.NextAction);
  assert.equal(vm.Type, 'DisconnectParticipant');
  assert.equal(content.Metadata.ActionMetadata[vm.Identifier].outboundiq.voicemail, true);
});

test('compile: identifiers are <= 50 chars, unique, and free of forbidden characters', () => {
  const spec = clone(MAIN_LINE);
  spec.menu.options.push({ digit: '*', label: 'Weird (label) with: = $ , ; [ ] { } / \\', action: { type: 'play_message', message: 'Star.' } });
  spec.menu.options.push({ digit: '#', action: { type: 'hangup' } });
  const { content } = compileFlow(spec, ctx);
  const ids = content.Actions.map((a) => a.Identifier);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.ok(id.length <= 50, id);
    assert.doesNotMatch(id, /[%:()\\/=$,;[\]{}]/);
  }
  assert.deepEqual(validateFlowContent(content).errors, []);
});

test('export: Main_Line round-trips through Flow language back to the same spec', () => {
  const { content } = compileFlow(MAIN_LINE, ctx);
  const ex = exportFlowSpec(JSON.stringify(content), exportCtx(MAIN_LINE));
  assert.deepEqual(ex.warnings, []);
  const expected = normalizeSpec(MAIN_LINE);
  expected.hours.hours_of_operation = 'Main_Line Hours';
  assert.deepEqual(normalizeSpec(ex.spec), expected);
  assert.deepEqual(ex.gaps, [GAPS.voicemail]);
});

test('export: play_message (return to menu, then hangup), timeouts, and 3-level menus round-trip', () => {
  const spec = {
    name: 'Deep_Menu',
    greeting: 'Hello.',
    menu: {
      prompt: 'Press 1 for hours, 2 for more, 3 to hear this and leave.',
      timeout_seconds: 8,
      options: [
        { digit: '1', label: 'Hours', action: { type: 'play_message', message: 'We are open nine to five.' } },
        { digit: '2', action: { type: 'submenu', menu: { prompt: 'Press 1 for level three, 9 to go back.', options: [
          { digit: '1', action: { type: 'submenu', menu: { prompt: 'Level three. Press 1 for support, 9 to go back.', options: [
            { digit: '1', action: { type: 'transfer_to_queue', queue: 'Support' } },
            { digit: '9', action: { type: 'previous_menu' } },
          ], no_input: { retries: 0, then: { type: 'previous_menu' } } } } },
          { digit: '9', action: { type: 'previous_menu' } },
        ] } } },
        { digit: '3', action: { type: 'play_message', message: 'Goodbye.', then: { type: 'hangup' } } },
      ],
      no_input: { retries: 1, message: 'Try again.', then: { type: 'transfer_to_queue', queue: 'Operator', message: 'Let me get someone.' } },
    },
  };
  assert.equal(validateSpec(spec).ok, true, validateSpec(spec).errors.join('; '));
  const { content } = compileFlow(spec, { queueArn: QARN });
  assert.deepEqual(validateFlowContent(content).errors, []);
  const ex = exportFlowSpec(content, {});
  assert.deepEqual(normalizeSpec(ex.spec), normalizeSpec(spec));
});

test('export: foreign flows (not built here) still export, with unsupported actions reported', () => {
  const foreign = {
    Version: '2019-10-30',
    StartAction: 'log',
    Actions: [
      { Identifier: 'log', Type: 'UpdateFlowLoggingBehavior', Parameters: { FlowLoggingBehavior: 'Enabled' }, Transitions: { NextAction: 'hello' } },
      { Identifier: 'hello', Type: 'MessageParticipant', Parameters: { Text: 'Hi there.' }, Transitions: { NextAction: 'menu', Errors: [] } },
      { Identifier: 'menu', Type: 'GetParticipantInput', Parameters: { Text: 'Press 1 or 2.', StoreInput: 'False', InputTimeLimitSeconds: '5' }, Transitions: {
        NextAction: 'bye',
        Conditions: [
          { NextAction: 'q', Condition: { Operator: 'Equals', Operands: ['1'] } },
          { NextAction: 'lambda', Condition: { Operator: 'Equals', Operands: ['2'] } },
        ],
        Errors: [{ NextAction: 'bye', ErrorType: 'InputTimeLimitExceeded' }, { NextAction: 'bye', ErrorType: 'NoMatchingCondition' }, { NextAction: 'bye', ErrorType: 'NoMatchingError' }],
      } },
      { Identifier: 'q', Type: 'UpdateContactTargetQueue', Parameters: { QueueId: QARN('abc') }, Transitions: { NextAction: 'x', Errors: [{ NextAction: 'bye', ErrorType: 'NoMatchingError' }] } },
      { Identifier: 'x', Type: 'TransferContactToQueue', Parameters: {}, Transitions: { NextAction: 'bye', Errors: [{ NextAction: 'bye', ErrorType: 'QueueAtCapacity' }, { NextAction: 'bye', ErrorType: 'NoMatchingError' }] } },
      { Identifier: 'lambda', Type: 'InvokeLambdaFunction', Parameters: { LambdaFunctionARN: 'arn:aws:lambda:us-east-1:1:function:f' }, Transitions: { NextAction: 'bye' } },
      { Identifier: 'bye', Type: 'DisconnectParticipant', Parameters: {}, Transitions: {} },
    ],
  };
  const ex = exportFlowSpec(foreign, { queueNameByArn: { [QARN('abc')]: 'Front Desk' } }, 'Foreign');
  assert.equal(ex.spec.greeting, 'Hi there.');
  assert.equal(ex.spec.menu.options[0].action.queue, 'Front Desk');
  assert.equal(ex.spec.menu.options[1].action.unsupported, 'InvokeLambdaFunction');
  assert.ok(ex.warnings.some((w) => /InvokeLambdaFunction/.test(w)));
  assert.ok(ex.warnings.some((w) => /UpdateFlowLoggingBehavior/.test(w)));
  const m = flowToMermaid(foreign);
  assert.match(m, /^flowchart TD/);
  assert.match(m, /Set queue: abc/);
  assert.match(m, /InvokeLambdaFunction/);
});

test('validateSpec: rejects bad specs with precise errors', () => {
  const bad = (mut, re) => {
    const s = clone(MAIN_LINE);
    mut(s);
    const v = validateSpec(s);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => re.test(e)), `${re} not in ${v.errors.join(' | ')}`);
  };
  bad((s) => { s.menu.options[0].digit = '12'; }, /digit must be one of/);
  bad((s) => { s.menu.options[1].digit = '1'; }, /duplicate digit/);
  bad((s) => { s.menu.options[0].action = { type: 'previous_menu' }; }, /only makes sense inside a submenu/);
  bad((s) => { s.menu.options[0].action = { type: 'transfer_to_queue' }; }, /needs a queue/);
  bad((s) => { s.menu.options[0].action = { type: 'dial', number: '+15555550100' }; }, /type must be one of/);
  bad((s) => { s.hours.schedule[0].end = '07:00'; }, /end must be after start/);
  bad((s) => { s.hours.schedule[0].days = ['funday']; }, /not a day name/);
  bad((s) => { s.hours.timezone = ''; }, /IANA time zone/);
  bad((s) => { s.name = 'bad/name'; }, /name must be/);
  bad((s) => {
    s.menu.options[1].action.menu.options[0].action = { type: 'submenu', menu: { prompt: 'L3', options: [{ digit: '1', action: { type: 'submenu', menu: { prompt: 'L4', options: [{ digit: '1', action: { type: 'hangup' } }] } } }] } };
  }, /at most 3 levels/);
});

test('hours: spec <-> Connect config, 24:00 maps to 00:00-00:00, always-open detection', () => {
  const cfg = specHoursToConfig({ timezone: 'America/New_York', schedule: [{ days: ['monday', 'friday'], start: '08:00', end: '18:00' }, { days: ['saturday'], start: '10:00', end: '24:00' }] });
  assert.deepEqual(cfg[0], { Day: 'MONDAY', StartTime: { Hours: 8, Minutes: 0 }, EndTime: { Hours: 18, Minutes: 0 } });
  assert.deepEqual(cfg[2], { Day: 'SATURDAY', StartTime: { Hours: 10, Minutes: 0 }, EndTime: { Hours: 0, Minutes: 0 } });
  assert.deepEqual(configToSchedule(cfg), [{ days: ['monday', 'friday'], start: '08:00', end: '18:00' }, { days: ['saturday'], start: '10:00', end: '24:00' }]);
  const basic = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'].map((Day) => ({ Day, StartTime: { Hours: 0, Minutes: 0 }, EndTime: { Hours: 0, Minutes: 0 } }));
  assert.equal(isAlwaysOpen(basic), true);
  assert.equal(isAlwaysOpen(cfg), false);
  assert.throws(() => specHoursToConfig({ timezone: 'America/New_York', schedule: [{ days: ['monday'], start: '08:00', end: '12:00' }, { days: ['monday'], start: '11:00', end: '13:00' }] }), /overlapping/);
});

test('mermaid: the spec preview names every branch, the back-link, and the voicemail gap', () => {
  const m = specToMermaid(MAIN_LINE);
  assert.match(m, /^flowchart TD/);
  assert.match(m, /1 Sales/);
  assert.match(m, /Queue: Support_Escalations/);
  assert.match(m, /9 \(back\)/);
  assert.match(m, /Voicemail \(GAP/);
  assert.doesNotMatch(m, /\u2014/); // no em dashes anywhere
});

test('walkSpec: press 2 then 1 lands in Support; bad digits are explained', () => {
  const w = walkSpec(MAIN_LINE, ['2', '1']);
  assert.equal(w.end.type, 'transfer_to_queue');
  assert.equal(w.end.queue, 'Support');
  assert.deepEqual(w.steps.filter((s) => s.kind === 'press').map((s) => s.digit), ['2', '1']);
  assert.throws(() => walkSpec(MAIN_LINE, ['7']), /not an option/);
  assert.throws(() => walkSpec(MAIN_LINE, ['1', '1']), /ends the call path/);
  assert.equal(walkSpec(MAIN_LINE, ['2', '9', '3']).end.queue, 'Billing');
});

test('native test content: observations hear each prompt, press DTMF, and assert the queue', () => {
  const { content } = compileFlow(MAIN_LINE, ctx);
  const ex = exportFlowSpec(content, { ...exportCtx(MAIN_LINE), includeRefs: true, queueNameByArn: { [QARN('Support')]: 'MCP_Test_Support' } });
  const t = buildTestContent({ spec: ex.spec, digits: ['2', '1'], hoursOverride: { from: HARN, to: 'arn:always-open' } });
  const obs = t.content.Observations;
  assert.equal(t.content.Version, '2019-10-30');
  assert.equal(obs[0].Event.Type, 'TestInitiated');
  assert.equal(obs[0].Actions[0].Parameters.Behavior.Properties.Strategy.SubstituteArn, 'arn:always-open');
  assert.equal(obs[1].Event.Properties.Text, 'Thanks for calling Acme Home Services.');
  assert.equal(obs[2].Actions[0].Parameters.Instruction.Properties.Value, '2');
  assert.equal(obs[3].Actions[0].Parameters.Instruction.Properties.Value, '1');
  const last = obs[obs.length - 1];
  assert.equal(last.Event.Properties.ActionParameters.QueueId, QARN('Support'));
  assert.equal(last.Actions[0].Parameters.Operand, 'MCP_Test_Support');
  assert.equal(last.Actions[1].Parameters.Command.Type, 'EndTest');
  for (let k = 0; k < obs.length - 1; k++) assert.deepEqual(obs[k].Transitions.NextObservations, [obs[k + 1].Identifier]);
  assert.ok(obs.every((o) => o.Event.Type !== 'MessageReceived' || o.Event.Properties.MatchingCriteria.Type === 'Similarity'));
  assert.equal(t.expectation.queue, 'MCP_Test_Support');
});

test('native test records summarize into a transcript', () => {
  const rec = (o) => ({ ObservationId: o.id, RecordType: o.type, Status: 'PASSED', Record: JSON.stringify(o.body) });
  const s = summarizeRecords([
    rec({ id: 'a', type: 'EXECUTION_START', body: { ContactId: 'c-1' } }),
    rec({ id: '1 Greeting', type: 'OBSERVATION', body: { Event: { Type: 'MessageReceived', Properties: { Text: 'For sales, press one', ExpectedText: 'For sales, press 1' } }, Actions: [] } }),
    rec({ id: 'z', type: 'COMPLETION', body: { CompletionReason: { Message: 'Test case execution completed.' }, ExecutionSummary: { ExecutionDurationMs: 26210 } } }),
  ]);
  assert.equal(s.contactId, 'c-1');
  assert.equal(s.steps[0].heard, 'For sales, press one');
  assert.equal(s.completion.durationMs, 26210);
});
