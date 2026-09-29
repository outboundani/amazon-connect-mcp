// The shared IVR spec <-> Amazon Connect Flow language.
//
//   validateSpec(spec)             -> { ok, errors, gaps }
//   compileFlow(spec, ctx)         -> { content, gaps, warnings }   (Flow language JSON)
//   validateFlowContent(content)   -> { ok, errors, warnings }      (local structural check)
//   exportFlowSpec(content, ctx)   -> { spec, gaps, warnings }      (Flow language JSON -> spec)
//   specToMermaid(spec) / flowToMermaid(content)
//   specHoursToConfig(hours) / configToSchedule(config)
//
// The spec is the contract shared with twilio-mcp (build_ivr / export_ivr_spec):
// { name, language?, greeting?, hours?: { timezone, schedule: [{days, start, end}],
//   closed?: { message?, then? } }, menu: { prompt, timeout_seconds?, options: [{ digit,
//   label?, action }], no_input?: { retries?, message?, then? } } }
// Action types: transfer_to_queue (queue, message?), submenu (menu), previous_menu,
// play_message (message, then?), voicemail (message?), hangup. Max 3 menu levels.
//
// Flow language realities this module encodes (verified live against a real
// instance, see about.js):
//   - GetParticipantInput must declare the NoMatchingError, NoMatchingCondition
//     and InputTimeLimitExceeded errors or PUBLISHED validation rejects it
//   - DTMF branches are Conditions {Operator: Equals, Operands: ["<digit>"]}
//   - routing to a queue is two actions: UpdateContactTargetQueue (QueueId =
//     queue ARN) then TransferContactToQueue (no parameters)
//   - CheckHoursOfOperation branches on Conditions "True" / "False"
//   - action Identifiers: max 50 chars, none of % : ( \ / ) = $ , ; [ ] { }
//   - Metadata is stored verbatim, so labels and gap markers ride along in
//     Metadata.ActionMetadata[id].outboundiq and survive a round trip
//   - Amazon Connect has NO native voicemail block (see GAPS below)

export const FLOW_VERSION = '2019-10-30';
export const ACTION_TYPES = ['transfer_to_queue', 'submenu', 'previous_menu', 'play_message', 'voicemail', 'hangup'];
export const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '#'];
export const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MAX_DEPTH = 3;
const ID_FORBIDDEN = /[%:()\\/=$,;[\]{}]/;

export const GAPS = {
  voicemail: 'voicemail: Amazon Connect has no native voicemail block. This flow plays the preceding message and hangs up where the spec says voicemail. For real voicemail, add Voicemail Express (github.com/amazon-connect/voicemail-express-amazon-connect) or a Start media streaming + Kinesis/Lambda recording design, then point this branch at it.',
  language: (lang) => `language: no Amazon Polly voice is mapped for "${lang}", so the flow keeps the instance default voice.`,
};

// Polly neural voices per language (the flow sets one with UpdateContactTextToSpeechVoice).
export const VOICES = {
  'en-US': 'Joanna', 'en-GB': 'Amy', 'en-AU': 'Olivia', 'en-IN': 'Kajal', 'es-US': 'Lupe', 'es-ES': 'Lucia',
  'es-MX': 'Mia', 'fr-CA': 'Gabrielle', 'fr-FR': 'Lea', 'de-DE': 'Vicki', 'it-IT': 'Bianca', 'pt-BR': 'Camila',
  'pt-PT': 'Ines', 'ja-JP': 'Takumi', 'ko-KR': 'Seoyeon', 'nl-NL': 'Laura',
};
const LANG_BY_VOICE = Object.fromEntries(Object.entries(VOICES).map(([l, v]) => [v, l]));

const DEFAULT_TRANSFER_ERROR = 'Sorry, we are unable to take your call right now. Please try again later. Goodbye.';

// ---------- spec validation ----------

const isText = (s) => typeof s === 'string' && s.trim().length > 0;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

export function validateSpec(spec, { requireMenu = false } = {}) {
  const errors = [];
  const gaps = new Set();
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, errors: ['spec must be an object'], gaps: [] };
  const name = String(spec.name ?? '').trim();
  if (!name) errors.push('name is required');
  else if (!/^[\w][\w .-]{0,126}$/.test(name)) errors.push('name must be 1-127 chars: letters, digits, spaces, dot, dash, underscore');
  if (spec.language !== undefined) {
    if (typeof spec.language !== 'string' || !/^[a-z]{2}-[A-Z]{2}$/.test(spec.language)) errors.push('language must look like en-US');
    else if (!VOICES[spec.language]) gaps.add(GAPS.language(spec.language));
  }
  if (spec.greeting !== undefined && !isText(spec.greeting)) errors.push('greeting must be non-empty text');
  if (spec.hours !== undefined) {
    const h = spec.hours;
    if (!h || typeof h !== 'object') errors.push('hours must be an object');
    else {
      try { specHoursToConfig(h); } catch (e) { errors.push(e.message); }
      if (h.closed !== undefined) {
        if (!h.closed || typeof h.closed !== 'object') errors.push('hours.closed must be an object');
        else {
          if (h.closed.message !== undefined && !isText(h.closed.message)) errors.push('hours.closed.message must be non-empty text');
          if (h.closed.then !== undefined) checkAction(h.closed.then, 'hours.closed.then', 0, errors, gaps);
        }
      }
    }
  }
  if (spec.menu === undefined) {
    if (requireMenu) errors.push('menu is required');
    else if (!isText(spec.greeting)) errors.push('a spec needs a menu, or at least a greeting');
  } else checkMenu(spec.menu, 'menu', 1, errors, gaps);
  return { ok: !errors.length, errors, gaps: [...gaps] };
}

function checkMenu(menu, path, depth, errors, gaps) {
  if (!menu || typeof menu !== 'object' || Array.isArray(menu)) { errors.push(`${path} must be an object`); return; }
  if (depth > MAX_DEPTH) { errors.push(`${path}: menus nest at most ${MAX_DEPTH} levels deep`); return; }
  if (!isText(menu.prompt)) errors.push(`${path}.prompt (text) is required`);
  if (menu.timeout_seconds !== undefined && !(Number.isInteger(menu.timeout_seconds) && menu.timeout_seconds >= 1 && menu.timeout_seconds <= 180)) {
    errors.push(`${path}.timeout_seconds must be an integer 1-180`);
  }
  const opts = menu.options;
  if (!Array.isArray(opts) || !opts.length) { errors.push(`${path}.options must be a non-empty array`); return; }
  if (opts.length > 12) errors.push(`${path}.options allows at most 12 entries (0-9, *, #)`);
  const seen = new Set();
  opts.forEach((o, i) => {
    const where = `${path}.options[${i}]`;
    if (!o || typeof o !== 'object') { errors.push(`${where} must be an object`); return; }
    const d = String(o.digit ?? '');
    if (!DIGITS.includes(d)) errors.push(`${where}.digit must be one of 0-9, *, # (got "${o.digit}")`);
    else if (seen.has(d)) errors.push(`${where}: duplicate digit "${d}"`);
    seen.add(d);
    if (o.label !== undefined && typeof o.label !== 'string') errors.push(`${where}.label must be text`);
    checkAction(o.action, `${where}.action`, depth, errors, gaps);
  });
  if (menu.no_input !== undefined) {
    const n = menu.no_input;
    if (!n || typeof n !== 'object') errors.push(`${path}.no_input must be an object`);
    else {
      if (n.retries !== undefined && !(Number.isInteger(n.retries) && n.retries >= 0 && n.retries <= 5)) errors.push(`${path}.no_input.retries must be an integer 0-5`);
      if (n.message !== undefined && !isText(n.message)) errors.push(`${path}.no_input.message must be non-empty text`);
      if (n.then !== undefined) checkAction(n.then, `${path}.no_input.then`, depth, errors, gaps);
    }
  }
}

// depth = the menu level this action runs in (0 = outside any menu).
function checkAction(a, where, depth, errors, gaps) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) { errors.push(`${where} must be an object with a type`); return; }
  if (!ACTION_TYPES.includes(a.type)) { errors.push(`${where}.type must be one of ${ACTION_TYPES.join(', ')} (got "${a.type}")`); return; }
  switch (a.type) {
    case 'transfer_to_queue':
      if (!isText(a.queue)) errors.push(`${where}: transfer_to_queue needs a queue (name or id)`);
      if (a.message !== undefined && !isText(a.message)) errors.push(`${where}.message must be non-empty text`);
      break;
    case 'submenu':
      if (depth === 0) errors.push(`${where}: submenu only works inside a menu option`);
      else checkMenu(a.menu, `${where}.menu`, depth + 1, errors, gaps);
      break;
    case 'previous_menu':
      if (depth < 2) errors.push(`${where}: previous_menu only makes sense inside a submenu (the main menu has no parent)`);
      break;
    case 'play_message':
      if (!isText(a.message)) errors.push(`${where}: play_message needs a message`);
      if (a.then !== undefined) {
        if (a.then?.type === 'submenu') errors.push(`${where}.then: use a menu option for submenus, not play_message.then`);
        else checkAction(a.then, `${where}.then`, depth, errors, gaps);
      }
      break;
    case 'voicemail':
      if (a.message !== undefined && !isText(a.message)) errors.push(`${where}.message must be non-empty text`);
      gaps.add(GAPS.voicemail);
      break;
    default:
      break;
  }
}

// ---------- hours ----------

const toSlice = (hhmm) => {
  if (hhmm === '24:00') return { Hours: 0, Minutes: 0 };
  const [h, m] = hhmm.split(':').map(Number);
  return { Hours: h, Minutes: m };
};
const fromSlice = (s, isEnd) => {
  const v = `${String(s?.Hours ?? 0).padStart(2, '0')}:${String(s?.Minutes ?? 0).padStart(2, '0')}`;
  return isEnd && v === '00:00' ? '24:00' : v;
};

// spec.hours -> CreateHoursOfOperation Config. Connect encodes an all-day
// window as 00:00-00:00; "24:00" in the spec maps to that.
export function specHoursToConfig(hours) {
  if (!hours || typeof hours !== 'object') throw new Error('hours must be an object');
  if (!isText(hours.timezone) || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(hours.timezone)) throw new Error('hours.timezone must be an IANA time zone, e.g. America/New_York');
  if (!Array.isArray(hours.schedule) || !hours.schedule.length) throw new Error('hours.schedule must be a non-empty array of { days, start, end }');
  const config = [];
  const seen = new Map();
  hours.schedule.forEach((w, i) => {
    const where = `hours.schedule[${i}]`;
    if (!w || !Array.isArray(w.days) || !w.days.length) throw new Error(`${where}.days must be a non-empty array of day names`);
    if (!HHMM.test(String(w.start)) || String(w.start) === '24:00') throw new Error(`${where}.start must be HH:MM (24h)`);
    if (!HHMM.test(String(w.end))) throw new Error(`${where}.end must be HH:MM (24h, 24:00 for midnight)`);
    const startMin = Number(w.start.slice(0, 2)) * 60 + Number(w.start.slice(3));
    const endMin = w.end === '24:00' ? 1440 : Number(w.end.slice(0, 2)) * 60 + Number(w.end.slice(3));
    if (endMin <= startMin) throw new Error(`${where}: end must be after start (windows that cross midnight: split them into two days)`);
    for (const dRaw of w.days) {
      const d = String(dRaw).toLowerCase();
      if (!DAYS.includes(d)) throw new Error(`${where}.days: "${dRaw}" is not a day name`);
      const list = seen.get(d) || [];
      if (list.some(([s, e]) => startMin < e && s < endMin)) throw new Error(`${where}: ${d} has overlapping windows`);
      list.push([startMin, endMin]);
      seen.set(d, list);
      config.push({ Day: d.toUpperCase(), StartTime: toSlice(w.start), EndTime: toSlice(w.end) });
    }
  });
  return config;
}

// Connect Config -> spec schedule, grouping days that share a window.
export function configToSchedule(config = []) {
  const byWindow = new Map();
  for (const c of config) {
    const key = `${fromSlice(c.StartTime, false)}-${fromSlice(c.EndTime, true)}`;
    if (!byWindow.has(key)) byWindow.set(key, []);
    byWindow.get(key).push(String(c.Day).toLowerCase());
  }
  return [...byWindow.entries()].map(([k, days]) => {
    const [start, end] = k.split('-');
    return { days: DAYS.filter((d) => days.includes(d)), start, end };
  });
}

// True when every day is open around the clock (e.g. "Basic Hours").
export function isAlwaysOpen(config = []) {
  return DAYS.every((d) => config.some((c) => String(c.Day).toLowerCase() === d && fromSlice(c.StartTime) === '00:00' && fromSlice(c.EndTime, true) === '24:00'));
}

// ---------- compile ----------

// ctx: { queueArn(name) -> ARN (throws if unknown), hoursArn: ARN|null,
//        transferErrorMessage? }
export function compileFlow(spec, ctx = {}) {
  const v = validateSpec(spec);
  if (!v.ok) throw new Error(`Spec is invalid: ${v.errors.join('; ')}`);
  const gaps = new Set(v.gaps);
  const warnings = [];
  const actions = [];
  const meta = {};
  const ids = new Set();

  const makeId = (base) => {
    const clean = String(base).replace(/[%:()\\/=$,;[\]{}]/g, ' ').replace(/\s+/g, ' ').trim() || 'Action';
    let id = clean.slice(0, 50);
    let n = 2;
    while (ids.has(id)) id = `${clean.slice(0, 44).trim()} ${n++}`;
    ids.add(id);
    return id;
  };
  const add = (base, Type, Parameters, Transitions, oiq) => {
    const id = makeId(base);
    actions.push({ Identifier: id, Type, Parameters, Transitions });
    if (oiq) meta[id] = { outboundiq: oiq };
    return id;
  };
  // Lazily created shared endings.
  let disconnectId = null;
  const disconnect = () => disconnectId || (disconnectId = add('Disconnect', 'DisconnectParticipant', {}, {}));
  let xferFailId = null;
  const transferFailed = () => xferFailId || (xferFailId = message('Transfer failed', ctx.transferErrorMessage || DEFAULT_TRANSFER_ERROR, disconnect(), { role: 'transfer_error' }));

  function message(base, text, next, oiq) {
    return add(base, 'MessageParticipant', { Text: text }, { NextAction: next, Errors: [{ NextAction: next, ErrorType: 'NoMatchingError' }] }, oiq);
  }

  // Forward references: a menu's first attempt id is reserved before its
  // options compile, so previous_menu and play_message can point at it.
  const menuEntry = new Map(); // menu object -> first attempt id

  // Compiles an action and returns the id callers should transition to.
  // scope: { base, menu (current menu or null), parent (parent menu or null) }
  function compileAction(a, scope) {
    switch (a.type) {
      case 'transfer_to_queue': {
        const arn = ctx.queueArn ? ctx.queueArn(a.queue) : `QUEUE_ARN_FOR_${a.queue}`;
        const xfer = add(`${scope.base} transfer`, 'TransferContactToQueue', {}, {
          NextAction: transferFailed(),
          Errors: [{ NextAction: transferFailed(), ErrorType: 'QueueAtCapacity' }, { NextAction: transferFailed(), ErrorType: 'NoMatchingError' }],
        });
        const setQ = add(`${scope.base} queue`, 'UpdateContactTargetQueue', { QueueId: arn }, {
          NextAction: xfer, Errors: [{ NextAction: transferFailed(), ErrorType: 'NoMatchingError' }],
        }, { queue: a.queue });
        return a.message ? message(`${scope.base} message`, a.message, setQ) : setQ;
      }
      case 'submenu':
        return compileMenu(a.menu, { key: scope.childKey, parent: scope.menu });
      case 'previous_menu':
        return menuEntry.get(scope.parent);
      case 'play_message': {
        let next;
        if (a.then) next = compileAction(a.then, { ...scope, base: `${scope.base} then` });
        else next = scope.menu ? menuEntry.get(scope.menu) : disconnect();
        return message(`${scope.base} play`, a.message, next);
      }
      case 'voicemail':
        gaps.add(GAPS.voicemail);
        // Marker action so the exporter can say "voicemail" instead of
        // "hangup". It plays nothing; it only disconnects.
        return add(`${scope.base} voicemail gap`, 'DisconnectParticipant', {}, {}, { voicemail: true, message: a.message ?? null });
      case 'hangup':
      default:
        return disconnect();
    }
  }

  function compileMenu(menu, { key, parent }) {
    const label = key ? `Menu ${key}` : 'Main menu';
    const tries = (menu.no_input?.retries ?? 2) + 1;
    const tryIds = [];
    for (let t = 1; t <= tries; t++) tryIds.push(makeId(`${label} try ${t}`));
    menuEntry.set(menu, tryIds[0]);

    // Options compile once; every attempt shares the same targets.
    const conditions = menu.options.map((o) => {
      const d = String(o.digit);
      const target = compileAction(o.action, { base: `${label} ${d}`, menu, parent, childKey: key ? `${key}-${d}` : d });
      return { NextAction: target, Condition: { Operator: 'Equals', Operands: [d] } };
    });

    // After the last attempt: no_input.message (if any) then no_input.then.
    const finalThen = menu.no_input?.then ? compileAction(menu.no_input.then, { base: `${label} no input`, menu, parent }) : disconnect();
    const failAfter = [];
    for (let t = 1; t <= tries; t++) {
      const next = t < tries ? tryIds[t] : finalThen;
      failAfter.push(menu.no_input?.message ? message(`${label} no input ${t}`, menu.no_input.message, next, { role: 'no_input' }) : next);
    }
    const labels = Object.fromEntries(menu.options.filter((o) => o.label).map((o) => [String(o.digit), o.label]));
    tryIds.forEach((id, i) => {
      actions.push({
        Identifier: id,
        Type: 'GetParticipantInput',
        Parameters: { Text: menu.prompt, StoreInput: 'False', InputTimeLimitSeconds: String(menu.timeout_seconds ?? 5) },
        Transitions: {
          NextAction: failAfter[i],
          Conditions: conditions,
          Errors: [
            { NextAction: failAfter[i], ErrorType: 'InputTimeLimitExceeded' },
            { NextAction: failAfter[i], ErrorType: 'NoMatchingCondition' },
            { NextAction: failAfter[i], ErrorType: 'NoMatchingError' },
          ],
        },
      });
      meta[id] = { outboundiq: { menu: key || 'main', attempt: i + 1, of: tries, ...(i === 0 && Object.keys(labels).length ? { labels } : {}) } };
    });
    return tryIds[0];
  }

  // Build back to front: menu, greeting, hours, voice.
  let start = spec.menu ? compileMenu(spec.menu, { key: '', parent: null }) : disconnect();
  if (spec.greeting) start = message('Greeting', spec.greeting, start, { role: 'greeting' });
  if (spec.hours) {
    if (!ctx.hoursArn) warnings.push('spec.hours is set but no hours of operation resource was supplied; compiled without an hours check.');
    else {
      const closedThen = spec.hours.closed?.then ? compileAction(spec.hours.closed.then, { base: 'Closed', menu: null, parent: null }) : disconnect();
      const closedEntry = spec.hours.closed?.message ? message('Closed message', spec.hours.closed.message, closedThen, { role: 'closed' }) : closedThen;
      start = add('Hours check', 'CheckHoursOfOperation', { HoursOfOperationId: ctx.hoursArn }, {
        NextAction: start,
        Conditions: [
          { NextAction: start, Condition: { Operator: 'Equals', Operands: ['True'] } },
          { NextAction: closedEntry, Condition: { Operator: 'Equals', Operands: ['False'] } },
        ],
        Errors: [{ NextAction: start, ErrorType: 'NoMatchingError' }],
      }, { hours: ctx.hoursName || null });
    }
  }
  if (spec.language && VOICES[spec.language]) {
    start = add('Set voice', 'UpdateContactTextToSpeechVoice', { TextToSpeechVoice: VOICES[spec.language] }, {
      NextAction: start, Errors: [{ NextAction: start, ErrorType: 'NoMatchingError' }],
    }, { language: spec.language });
  }

  // Order actions from the start for readability; lay them out on a grid so
  // the flow opens cleanly in the Connect flow designer.
  const byId = new Map(actions.map((a) => [a.Identifier, a]));
  const ordered = [];
  const q = [start];
  const seen = new Set();
  while (q.length) {
    const id = q.shift();
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    const a = byId.get(id);
    ordered.push(a);
    for (const t of targetsOf(a)) q.push(t);
  }
  const ActionMetadata = {};
  ordered.forEach((a, i) => {
    ActionMetadata[a.Identifier] = { position: { x: 240 + (i % 6) * 260, y: 40 + Math.floor(i / 6) * 220 }, ...(meta[a.Identifier] || {}) };
  });
  const content = {
    Version: FLOW_VERSION,
    StartAction: start,
    Metadata: {
      entryPointPosition: { x: 40, y: 40 },
      ActionMetadata,
      outboundiq: { generator: 'amazon-connect-mcp', spec: spec.name, specVersion: 1 },
    },
    Actions: ordered,
  };
  return { content, gaps: [...gaps], warnings };
}

export function targetsOf(a) {
  const t = a?.Transitions || {};
  return [t.NextAction, ...(t.Conditions || []).map((c) => c.NextAction), ...(t.Errors || []).map((e) => e.NextAction)].filter(Boolean);
}

// ---------- local structural validation ----------

// Server-side validation only runs on PUBLISHED; this catches the common
// failures before a network call and explains them in plain words.
const REQUIRED_ERRORS = {
  GetParticipantInput: ['NoMatchingError', 'NoMatchingCondition', 'InputTimeLimitExceeded'],
  UpdateContactTargetQueue: ['NoMatchingError'],
  TransferContactToQueue: ['QueueAtCapacity', 'NoMatchingError'],
  CheckHoursOfOperation: ['NoMatchingError'],
  UpdateContactTextToSpeechVoice: ['NoMatchingError'],
};
const TERMINAL = new Set(['DisconnectParticipant', 'EndFlowExecution']);

export function validateFlowContent(content) {
  const errors = [];
  const warnings = [];
  let c = content;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { return { ok: false, errors: ['content is not valid JSON'], warnings }; } }
  if (!c || typeof c !== 'object') return { ok: false, errors: ['content must be an object'], warnings };
  if (c.Version !== FLOW_VERSION) errors.push(`Version must be "${FLOW_VERSION}"`);
  if (!Array.isArray(c.Actions) || !c.Actions.length) return { ok: false, errors: [...errors, 'Actions must be a non-empty array'], warnings };
  const ids = new Map();
  c.Actions.forEach((a, i) => {
    const where = `Actions[${i}]`;
    const id = a?.Identifier;
    if (typeof id !== 'string' || !id) { errors.push(`${where}: Identifier is required`); return; }
    if (id.length > 50) errors.push(`${where}: Identifier "${id}" is longer than 50 characters`);
    if (ID_FORBIDDEN.test(id)) errors.push(`${where}: Identifier "${id}" contains a forbidden character (% : ( \\ / ) = $ , ; [ ] { })`);
    if (ids.has(id)) errors.push(`${where}: duplicate Identifier "${id}"`);
    ids.set(id, a);
    if (typeof a.Type !== 'string') errors.push(`${where}: Type is required`);
    if (!a.Transitions || typeof a.Transitions !== 'object') errors.push(`${where}: Transitions is required (use {} for terminal actions)`);
  });
  if (!ids.has(c.StartAction)) errors.push(`StartAction "${c.StartAction}" does not match any action`);
  for (const a of c.Actions) {
    if (!a?.Identifier) continue;
    for (const t of targetsOf(a)) if (!ids.has(t)) errors.push(`${a.Identifier}: transition target "${t}" does not exist`);
    const req = REQUIRED_ERRORS[a.Type];
    if (req) {
      const have = new Set((a.Transitions?.Errors || []).map((e) => e.ErrorType));
      for (const r of req) if (!have.has(r)) errors.push(`${a.Identifier}: ${a.Type} must handle the ${r} error`);
    }
    if (!TERMINAL.has(a.Type) && !a.Transitions?.NextAction && !(a.Transitions?.Conditions || []).length) {
      errors.push(`${a.Identifier}: ${a.Type} has no NextAction (the call would dead-end)`);
    }
    if (a.Type === 'GetParticipantInput') {
      const ds = (a.Transitions?.Conditions || []).map((x) => x.Condition?.Operands?.[0]);
      if (new Set(ds).size !== ds.length) errors.push(`${a.Identifier}: duplicate digit branches`);
    }
    if (a.Type === 'UpdateContactTargetQueue' && !a.Parameters?.QueueId) errors.push(`${a.Identifier}: UpdateContactTargetQueue needs a QueueId`);
    if (a.Type === 'UpdateContactTargetQueue' && /^QUEUE_ARN_FOR_/.test(a.Parameters?.QueueId || '')) errors.push(`${a.Identifier}: queue "${a.Parameters.QueueId.slice(14)}" was not resolved to a real queue`);
  }
  // Reachability.
  const reach = new Set();
  const q = [c.StartAction];
  while (q.length) {
    const id = q.shift();
    if (reach.has(id) || !ids.has(id)) continue;
    reach.add(id);
    q.push(...targetsOf(ids.get(id)));
  }
  for (const id of ids.keys()) if (!reach.has(id)) warnings.push(`${id} is unreachable from the start`);
  return { ok: !errors.length, errors, warnings };
}

// ---------- export: Flow language -> spec ----------

// ctx: { queueNameByArn: {arn: name}, hours: {arn: {name, timezone, schedule}} }
export function exportFlowSpec(content, ctx = {}, name) {
  let c = content;
  if (typeof c === 'string') c = JSON.parse(c);
  const byId = new Map((c.Actions || []).map((a) => [a.Identifier, a]));
  const am = c.Metadata?.ActionMetadata || {};
  const oiq = (id) => am[id]?.outboundiq || {};
  const warnings = [];
  const gaps = new Set();
  const spec = { name: name || c.Metadata?.outboundiq?.spec || c.Metadata?.name || 'Exported_Flow' };

  const queueName = (arn) => ctx.queueNameByArn?.[arn] || (typeof arn === 'string' ? arn.split('/').pop() : arn);
  const menuOf = new Map(); // GPI id -> spec menu object
  const menus = []; // { menu, attemptIds:Set, parent }

  const follow = (id) => byId.get(id);
  const isDisconnect = (a) => a?.Type === 'DisconnectParticipant';

  function findMenu(id) {
    return menus.find((m) => m.attemptIds.has(id));
  }

  // Decode an action chain starting at `id`, in the context of `cur` (the
  // menu record the caller is in), into a spec action.
  function decode(id, cur, depthGuard = 0) {
    const a = follow(id);
    if (!a || depthGuard > 40) { warnings.push(`dangling or cyclic transition to "${id}"`); return { type: 'hangup' }; }
    if (a.Type === 'DisconnectParticipant') {
      if (oiq(id).voicemail) {
        gaps.add(GAPS.voicemail);
        return oiq(id).message ? { type: 'voicemail', message: oiq(id).message } : { type: 'voicemail' };
      }
      return { type: 'hangup' };
    }
    if (a.Type === 'UpdateContactTargetQueue') {
      const arn = a.Parameters?.QueueId;
      const out = { type: 'transfer_to_queue', queue: oiq(id).queue || queueName(arn) };
      // includeRefs: keep the Connect-side identity (used by run_flow_test).
      if (ctx.includeRefs) Object.assign(out, { queue_arn: arn, queue_name: queueName(arn) });
      return out;
    }
    if (a.Type === 'TransferContactToQueue') { warnings.push(`${id}: transfer without a preceding queue selection; exported with queue "(current queue)"`); return { type: 'transfer_to_queue', queue: '(current queue)' }; }
    if (a.Type === 'GetParticipantInput') {
      const m = findMenu(id);
      if (m && cur && m === cur.parent) return { type: 'previous_menu' };
      if (m && m === cur) return { type: 'previous_menu', note: 'loops back to the same menu' };
      if (m) { warnings.push(`${id}: jumps to an ancestor menu; exported as previous_menu`); return { type: 'previous_menu' }; }
      return { type: 'submenu', menu: decodeMenu(id, cur) };
    }
    if (a.Type === 'MessageParticipant') {
      const text = a.Parameters?.Text ?? a.Parameters?.SSML ?? '';
      const next = follow(a.Transitions?.NextAction);
      if (next?.Type === 'UpdateContactTargetQueue') return { ...decode(a.Transitions.NextAction, cur, depthGuard + 1), message: text };
      if (next?.Type === 'GetParticipantInput' && cur && findMenu(next.Identifier) === cur) return { type: 'play_message', message: text };
      const then = decode(a.Transitions?.NextAction, cur, depthGuard + 1);
      return { type: 'play_message', message: text, then };
    }
    if (a.Type === 'UpdateContactTextToSpeechVoice' || a.Type === 'UpdateFlowLoggingBehavior' || a.Type === 'UpdateContactRecordingBehavior') {
      return decode(a.Transitions?.NextAction, cur, depthGuard + 1);
    }
    warnings.push(`${id}: ${a.Type} has no spec equivalent; exported as hangup`);
    return { type: 'hangup', unsupported: a.Type };
  }

  function decodeMenu(firstId, parentRec) {
    const first = follow(firstId);
    const menu = { prompt: first.Parameters?.Text ?? '' };
    if (first.Parameters?.InputTimeLimitSeconds && String(first.Parameters.InputTimeLimitSeconds) !== '5') menu.timeout_seconds = Number(first.Parameters.InputTimeLimitSeconds);
    const rec = { menu, attemptIds: new Set([firstId]), parent: parentRec };
    menus.push(rec);
    menuOf.set(firstId, menu);

    // Walk the retry chain: GPI -> [message] -> GPI (same prompt + digits) ...
    const sig = (g) => `${g.Parameters?.Text}|${(g.Transitions?.Conditions || []).map((x) => x.Condition?.Operands?.[0]).join(',')}`;
    const firstSig = sig(first);
    let tries = 1;
    let noInputMsg;
    let failTarget = first.Transitions?.Errors?.find((e) => e.ErrorType === 'InputTimeLimitExceeded')?.NextAction || first.Transitions?.NextAction;
    for (;;) {
      let a = follow(failTarget);
      let msgText;
      if (a?.Type === 'MessageParticipant') {
        const after = follow(a.Transitions?.NextAction);
        const isNoInput = oiq(a.Identifier).role === 'no_input' || (after?.Type === 'GetParticipantInput' && sig(after) === firstSig);
        if (isNoInput) { msgText = a.Parameters?.Text; a = after; failTarget = a?.Identifier; }
      }
      if (a?.Type === 'GetParticipantInput' && sig(a) === firstSig && !rec.attemptIds.has(a.Identifier)) {
        rec.attemptIds.add(a.Identifier);
        if (msgText !== undefined && noInputMsg === undefined) noInputMsg = msgText;
        tries++;
        failTarget = a.Transitions?.Errors?.find((e) => e.ErrorType === 'InputTimeLimitExceeded')?.NextAction || a.Transitions?.NextAction;
        continue;
      }
      if (msgText !== undefined && noInputMsg === undefined) noInputMsg = msgText;
      break;
    }

    const labels = oiq(firstId).labels || {};
    menu.options = (first.Transitions?.Conditions || []).map((cnd) => {
      const digit = String(cnd.Condition?.Operands?.[0] ?? '');
      const opt = { digit };
      if (labels[digit]) opt.label = labels[digit];
      opt.action = decode(cnd.NextAction, rec);
      return opt;
    });

    // Final no-input branch (after the last attempt's optional message).
    const then = decode(failTarget, rec);
    const noInput = { retries: tries - 1 };
    if (noInputMsg !== undefined) noInput.message = noInputMsg;
    noInput.then = then;
    menu.no_input = noInput;
    return menu;
  }

  // Entry: voice, hours check, greeting, then the main menu.
  let id = c.StartAction;
  for (let guard = 0; guard < 20 && id; guard++) {
    const a = follow(id);
    if (!a) break;
    if (a.Type === 'UpdateContactTextToSpeechVoice') {
      const lang = LANG_BY_VOICE[a.Parameters?.TextToSpeechVoice];
      if (lang) spec.language = lang;
      id = a.Transitions?.NextAction;
      continue;
    }
    if (a.Type === 'CheckHoursOfOperation') {
      const arn = a.Parameters?.HoursOfOperationId;
      const info = ctx.hours?.[arn];
      const openTarget = a.Transitions?.Conditions?.find((x) => x.Condition?.Operands?.[0] === 'True')?.NextAction || a.Transitions?.NextAction;
      const closedTarget = a.Transitions?.Conditions?.find((x) => x.Condition?.Operands?.[0] === 'False')?.NextAction;
      const hours = info ? { timezone: info.timezone, schedule: info.schedule } : { hours_of_operation: oiq(id).hours || arn };
      if (info?.name) hours.hours_of_operation = info.name;
      if (closedTarget) {
        const ca = follow(closedTarget);
        if (ca?.Type === 'MessageParticipant') hours.closed = { message: ca.Parameters?.Text, then: decode(ca.Transitions?.NextAction, null) };
        else hours.closed = { then: decode(closedTarget, null) };
      }
      spec.hours = hours;
      id = openTarget;
      continue;
    }
    if (a.Type === 'MessageParticipant' && spec.greeting === undefined && !spec.menu) {
      spec.greeting = a.Parameters?.Text;
      id = a.Transitions?.NextAction;
      continue;
    }
    if (a.Type === 'GetParticipantInput') { spec.menu = decodeMenu(id, null); break; }
    if (a.Type === 'DisconnectParticipant') break;
    if (a.Transitions?.NextAction) {
      // Setup actions (logging, recording, attributes, event hooks, channel
      // checks) have no spec equivalent: skip along the default path, say so.
      warnings.push(`${id}: ${a.Type} skipped (no spec equivalent; followed its default path)`);
      id = a.Transitions.NextAction;
      continue;
    }
    warnings.push(`${id}: ${a.Type} at the entry has no spec equivalent; export stops here`);
    break;
  }
  return { spec, gaps: [...gaps], warnings };
}

// Drops fields the exporter adds that a hand-written spec usually omits
// (defaults), so round-trip comparisons are fair.
export function normalizeSpec(spec) {
  const s = JSON.parse(JSON.stringify(spec));
  const walkMenu = (m) => {
    if (!m) return;
    if (m.no_input) {
      m.no_input.retries ??= 2;
      m.no_input.then ??= { type: 'hangup' };
    } else m.no_input = { retries: 2, then: { type: 'hangup' } };
    if (m.timeout_seconds === 5) delete m.timeout_seconds;
    for (const o of m.options || []) walkAction(o.action);
    walkAction(m.no_input.then);
  };
  const walkAction = (a) => {
    if (!a) return;
    if (a.type === 'submenu') walkMenu(a.menu);
    if (a.type === 'play_message' && a.then) walkAction(a.then);
  };
  walkMenu(s.menu);
  if (s.hours?.closed && !s.hours.closed.then) s.hours.closed.then = { type: 'hangup' };
  return s;
}

// ---------- Mermaid ----------

const mq = (s, n = 60) => {
  const t = String(s ?? '').replace(/["\n\r]+/g, ' ').replace(/[<>]/g, '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}...` : t;
};

export function specToMermaid(spec) {
  const lines = ['flowchart TD'];
  let n = 0;
  const node = (label, shape = 'box') => {
    const id = `n${n++}`;
    const l = mq(label, 80);
    lines.push(shape === 'diamond' ? `  ${id}{"${l}"}` : shape === 'end' ? `  ${id}(["${l}"])` : shape === 'queue' ? `  ${id}[["${l}"]]` : `  ${id}["${l}"]`);
    return id;
  };
  const edge = (a, b, label) => lines.push(label ? `  ${a} -->|"${mq(label, 30)}"| ${b}` : `  ${a} --> ${b}`);
  const menuNodes = new Map();

  const drawAction = (from, a, label, menuCtx) => {
    switch (a?.type) {
      case 'transfer_to_queue': {
        let src = from;
        let lbl = label;
        if (a.message) { const m = node(`Say: ${a.message}`); edge(src, m, lbl); src = m; lbl = undefined; }
        edge(src, node(`Queue: ${a.queue}`, 'queue'), lbl);
        break;
      }
      case 'submenu': drawMenu(a.menu, from, label, menuCtx); break;
      case 'previous_menu': if (menuCtx?.parentNode) edge(from, menuCtx.parentNode, label ? `${label} (back)` : 'back'); break;
      case 'play_message': {
        const m = node(`Say: ${a.message}`);
        edge(from, m, label);
        if (a.then) drawAction(m, a.then, undefined, menuCtx);
        else if (menuCtx?.self) edge(m, menuCtx.self, 'repeat menu');
        else edge(m, node('Hang up', 'end'));
        break;
      }
      case 'voicemail': edge(from, node('Voicemail (GAP: no native block, hangs up)', 'end'), label); break;
      default: edge(from, node('Hang up', 'end'), label);
    }
  };

  const drawMenu = (menu, from, label, parentCtx) => {
    const self = node(`Menu: ${menu.prompt}`, 'diamond');
    menuNodes.set(menu, self);
    edge(from, self, label);
    const ctx = { self, parentNode: parentCtx?.self };
    for (const o of menu.options || []) drawAction(self, o.action, `${o.digit}${o.label ? ` ${o.label}` : ''}`, ctx);
    const ni = menu.no_input || {};
    const retries = ni.retries ?? 2;
    let src = self;
    if (ni.message) { const m = node(`Say: ${ni.message}`); edge(self, m, `no input x${retries + 1}`); src = m; }
    drawAction(src, ni.then || { type: 'hangup' }, src === self ? `no input x${retries + 1}` : undefined, ctx);
  };

  let cur = node(`Call arrives: ${spec.name}`, 'end');
  if (spec.hours) {
    const h = node(`Open? ${spec.hours.timezone || spec.hours.hours_of_operation || ''}`, 'diamond');
    edge(cur, h);
    let closedFrom = h;
    let closedLbl = 'closed';
    if (spec.hours.closed?.message) { const m = node(`Say: ${spec.hours.closed.message}`); edge(h, m, 'closed'); closedFrom = m; closedLbl = undefined; }
    drawAction(closedFrom, spec.hours.closed?.then || { type: 'hangup' }, closedLbl, null);
    cur = h;
    if (spec.greeting) { const g = node(`Say: ${spec.greeting}`); edge(h, g, 'open'); cur = g; } else if (spec.menu) { drawMenu(spec.menu, h, 'open', null); return lines.join('\n'); }
  } else if (spec.greeting) { const g = node(`Say: ${spec.greeting}`); edge(cur, g); cur = g; }
  if (spec.menu) drawMenu(spec.menu, cur, undefined, null);
  else edge(cur, node('Hang up', 'end'));
  return lines.join('\n');
}

// Faithful action-level diagram of ANY flow (not just ours).
export function flowToMermaid(content) {
  let c = content;
  if (typeof c === 'string') c = JSON.parse(c);
  const idx = new Map((c.Actions || []).map((a, i) => [a.Identifier, `a${i}`]));
  const lines = ['flowchart TD', '  start(["Start"])'];
  const label = (a) => {
    const p = a.Parameters || {};
    const text = p.Text || p.SSML || '';
    switch (a.Type) {
      case 'MessageParticipant': return `Say: ${text}`;
      case 'GetParticipantInput': return `Menu: ${text}`;
      case 'UpdateContactTargetQueue': return `Set queue: ${String(p.QueueId || '').split('/').pop()}`;
      case 'TransferContactToQueue': return 'Transfer to queue';
      case 'CheckHoursOfOperation': return 'Check hours';
      case 'DisconnectParticipant': return 'Hang up';
      case 'UpdateContactTextToSpeechVoice': return `Voice: ${p.TextToSpeechVoice}`;
      default: return a.Type;
    }
  };
  for (const a of c.Actions || []) {
    const id = idx.get(a.Identifier);
    const l = mq(label(a), 70);
    lines.push(a.Type === 'GetParticipantInput' || a.Type === 'CheckHoursOfOperation' ? `  ${id}{"${l}"}` : a.Type === 'DisconnectParticipant' ? `  ${id}(["${l}"])` : `  ${id}["${l}"]`);
  }
  if (idx.has(c.StartAction)) lines.push(`  start --> ${idx.get(c.StartAction)}`);
  for (const a of c.Actions || []) {
    const from = idx.get(a.Identifier);
    const t = a.Transitions || {};
    const drawn = new Set();
    for (const cnd of t.Conditions || []) {
      if (!idx.has(cnd.NextAction)) continue;
      lines.push(`  ${from} -->|"${mq(cnd.Condition?.Operands?.join(',') ?? '', 20)}"| ${idx.get(cnd.NextAction)}`);
    }
    if (t.NextAction && idx.has(t.NextAction)) { lines.push(`  ${from} --> ${idx.get(t.NextAction)}`); drawn.add(t.NextAction); }
    const errs = new Map();
    for (const e of t.Errors || []) {
      if (!idx.has(e.NextAction) || drawn.has(e.NextAction)) continue;
      errs.set(e.NextAction, [...(errs.get(e.NextAction) || []), e.ErrorType]);
    }
    for (const [target, types] of errs) lines.push(`  ${from} -.->|"${mq(types.join(', '), 40)}"| ${idx.get(target)}`);
  }
  return lines.join('\n');
}

// ---------- walking a spec (for simulated calls) ----------

// Follows a digit path through a spec and returns the steps a simulated
// caller hears/does, ending in the action the path lands on.
export function walkSpec(spec, digits) {
  const steps = [];
  if (spec.greeting) steps.push({ kind: 'hear', text: spec.greeting, what: 'greeting' });
  const stack = [];
  let menu = spec.menu;
  if (!menu) return { steps, end: { type: 'hangup' } };
  for (let i = 0; i < digits.length; i++) {
    const d = String(digits[i]);
    steps.push({ kind: 'hear', text: menu.prompt, what: 'menu' });
    steps.push({ kind: 'press', digit: d });
    const opt = (menu.options || []).find((o) => String(o.digit) === d);
    if (!opt) throw new Error(`Digit ${d} is not an option at step ${i + 1} (menu "${mq(menu.prompt, 40)}" offers ${(menu.options || []).map((o) => o.digit).join(', ')}).`);
    const a = opt.action;
    if (a.type === 'submenu') { stack.push(menu); menu = a.menu; continue; }
    if (a.type === 'previous_menu') { menu = stack.pop() || menu; continue; }
    if (i !== digits.length - 1) throw new Error(`Digit ${d} ends the call path (${a.type}) but more digits were given.`);
    return { steps, end: a, label: opt.label };
  }
  return { steps, end: { type: 'menu', menu } };
}
