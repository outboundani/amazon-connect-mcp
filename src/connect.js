// Amazon Connect API client: zero dependencies, SigV4 on Web Crypto.
//
// Every request passes through checkRequest() (src/rules.js) before a URL
// is built, typed tools included. The host is never caller-controlled: it
// comes from the service name and a validated region. Credentials are an
// IAM access key pair (plus an optional session token for temporary
// credentials); with no key, the client fails closed.

import { signRequest } from './sigv4.js';
import { checkRequest, hostFor, redactText, UUID_RE } from './rules.js';

export class ConnectError extends Error {
  constructor(message, status, type, extra = {}) {
    super(message);
    this.name = 'ConnectError';
    this.status = status;
    this.type = type;
    Object.assign(this, extra);
  }
}

const RETRYABLE = new Set(['ThrottlingException', 'TooManyRequestsException', 'LimitExceededException', 'InternalServiceException', 'ServiceUnavailableException']);

export class ConnectClient {
  constructor({ accessKeyId, secretAccessKey, sessionToken, region, instanceId } = {}) {
    this.accessKeyId = accessKeyId || '';
    this.secretAccessKey = secretAccessKey || '';
    this.sessionToken = sessionToken || '';
    this.region = region || 'us-east-1';
    this.instanceIdHint = instanceId || '';
    this._instanceId = null;
  }

  // Resolves the instance: the configured id, or, when none is configured,
  // the only instance in the account/region. Two or more without a
  // configured id is an error that lists them (never a guess).
  async instanceId() {
    if (this._instanceId) return this._instanceId;
    const hint = String(this.instanceIdHint || '').trim();
    if (hint) {
      const id = hint.includes('/') ? hint.split('/').pop() : hint;
      if (!UUID_RE.test(id)) throw new ConnectError(`"${hint}" is not a Connect instance id (expected a UUID or an instance ARN).`, 400, 'InvalidParameter');
      this._instanceId = id;
      return id;
    }
    const { entities } = await this.listAll('/instance', 'InstanceSummaryList', {}, { pageSize: 10, max: 50 });
    const active = entities.filter((i) => i.InstanceStatus === 'ACTIVE');
    if (active.length === 1) { this._instanceId = active[0].Id; return this._instanceId; }
    if (!active.length) throw new ConnectError(`No ACTIVE Amazon Connect instance found in ${this.region}.`, 404, 'ResourceNotFound');
    throw new ConnectError(`This account has ${active.length} Connect instances in ${this.region}; set CONNECT_INSTANCE_ID to pick one: ${active.map((i) => `${i.InstanceAlias} (${i.Id})`).join(', ')}.`, 409, 'AmbiguousInstance');
  }

  // Core request. `path` is absolute and built from ids; `query` is a flat
  // object; `body` is JSON-serializable. Retries throttles with backoff.
  async request(method, path, { query, body, service = 'connect', _attempt = 0 } = {}) {
    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new ConnectError('No AWS access key configured - refusing to send an unsigned request. Open /setup, or set AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.', 503, 'NotConfigured');
    }
    const c = checkRequest({ service, method, path, query, body });
    if (!c.ok) throw new ConnectError(c.message, 403, 'Refused');

    const host = hostFor(service, this.region);
    const url = new URL(`https://${host}${c.path}`);
    // Defense in depth: the URL parser must not have rewritten the path.
    if (url.pathname !== c.path || url.host !== host) throw new ConnectError(`Refused: the path "${c.path}" does not survive URL parsing unchanged.`, 403, 'Refused');
    for (const [k, v] of Object.entries(c.query)) url.searchParams.set(k, v);

    const payload = body === undefined ? '' : JSON.stringify(body);
    const signed = await signRequest({
      method: c.method,
      url: url.toString(),
      headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
      body: payload,
      accessKeyId: this.accessKeyId,
      secretAccessKey: this.secretAccessKey,
      sessionToken: this.sessionToken,
      region: this.region,
      service,
    });

    let res;
    try {
      res = await fetch(url.toString(), { method: c.method, headers: signed.headers, body: body === undefined ? undefined : payload });
    } catch (e) {
      throw new ConnectError(`Network error calling ${service} ${c.op}: ${e.message}`, 0, 'Network');
    }

    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 500) }; }
    if (res.ok) return data;

    // Error shape: x-amzn-ErrorType header ("Type:http://..." sometimes),
    // body {message|Message}. InvalidContactFlowException carries a
    // lower-case "problems" array; InvalidTestCaseException "Problems".
    const type = String(res.headers.get('x-amzn-ErrorType') || data.__type || data.code || `HTTP${res.status}`).split(':')[0].split('#').pop();
    if ((res.status === 429 || RETRYABLE.has(type)) && _attempt < 3 && type !== 'LimitExceededException') {
      await new Promise((r) => setTimeout(r, 400 * 3 ** _attempt));
      return this.request(method, path, { query, body, service, _attempt: _attempt + 1 });
    }
    // InvalidTestCaseException: problemDetails (the docs say Problems).
    const problems = data.problems || data.Problems || data.problemDetails;
    const msg = data.message || data.Message || (problems ? 'the flow failed validation' : text.slice(0, 300)) || `HTTP ${res.status}`;
    const clean = redactText(msg, [this.secretAccessKey, this.sessionToken, this.accessKeyId]);
    throw new ConnectError(`${c.op} failed (${type}): ${clean}`, res.status, type, problems ? { problems } : {});
  }

  get(path, query, opts) { return this.request('GET', path, { query, ...opts }); }
  put(path, body, opts) { return this.request('PUT', path, { body, ...opts }); }
  post(path, body, opts) { return this.request('POST', path, { body, ...opts }); }

  // NextToken pagination for GET list endpoints. Caps at `max` so a big
  // instance can't blow up a tool response.
  async listAll(path, key, query = {}, { max = 1000, pageSize = 100 } = {}) {
    const out = [];
    let next;
    for (let page = 0; page < 50; page++) {
      const res = await this.get(path, { ...query, maxResults: Math.min(pageSize, max), ...(next ? { nextToken: next } : {}) });
      out.push(...(res[key] || []));
      next = res.NextToken;
      if (!next || out.length >= max) break;
    }
    return { entities: out.slice(0, max), truncated: Boolean(next) || out.length > max };
  }

  // Same for POST list/search endpoints (token in the body).
  async listAllPost(path, key, body = {}, { max = 1000, pageSize = 100, service = 'connect' } = {}) {
    const out = [];
    let next;
    for (let page = 0; page < 50; page++) {
      const res = await this.post(path, { ...body, MaxResults: Math.min(pageSize, max), ...(next ? { NextToken: next } : {}) }, { service });
      out.push(...(res[key] || []));
      next = res.NextToken || res.nextToken;
      if (!next || out.length >= max) break;
    }
    return { entities: out.slice(0, max), truncated: Boolean(next) };
  }
}
