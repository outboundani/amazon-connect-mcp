// AWS Signature Version 4, hand-rolled on Web Crypto. Zero dependencies:
// it runs unchanged in Cloudflare Workers and Node 20+ (globalThis.crypto).
//
// aws4fetch is the reference implementation this follows; the unit tests
// check it against AWS's published SigV4 test suite vectors (vendored in
// botocore under tests/unit/auth/aws4_testsuite), so a regression in
// canonicalization shows up as a wrong signature, not a 403 in production.
//
// Scope: header-signed requests for REST-JSON services (Connect, Connect
// Campaigns). Not S3: no single-encoding of the path, no UNSIGNED-PAYLOAD.

const enc = new TextEncoder();

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

// RFC 3986 encoding as SigV4 wants it: everything except A-Z a-z 0-9 - _ . ~
// is percent-encoded with uppercase hex. encodeURIComponent leaves !'()*
// alone, so those are fixed up here.
export function uriEncode(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Canonical URI for non-S3 services: normalize dot segments, then encode
// each segment twice (once for the wire, once more for the canonical
// string). Callers of this module only ever pass plain segments (rules.js
// refuses anything else), so normalization is a formality here.
export function canonicalUri(pathname) {
  const segs = [];
  for (const s of String(pathname || '/').split('/')) {
    if (s === '..') segs.pop();
    else if (s !== '.' && s !== '') segs.push(s);
  }
  const trailing = pathname.length > 1 && pathname.endsWith('/') ? '/' : '';
  const wire = segs.map((s) => uriEncode(safeDecode(s)));
  return '/' + wire.map((s) => uriEncode(s)).join('/') + (segs.length ? trailing : '');
}

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// Canonical query: decode what the URL holds, re-encode strictly, sort by
// key then value (byte order on the encoded strings).
export function canonicalQuery(searchParams) {
  const pairs = [];
  for (const [k, v] of searchParams) pairs.push([uriEncode(k), uriEncode(v)]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function trimHeaderValue(v) {
  return String(v).trim().replace(/\s+/g, ' ');
}

export function amzDate(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

// Signs a request and returns the headers to send (the input headers plus
// host, x-amz-date, x-amz-content-sha256 when asked, x-amz-security-token,
// and authorization).
//   { method, url, headers, body, accessKeyId, secretAccessKey,
//     sessionToken?, region, service, datetime?, signContentSha256? }
export async function signRequest(opts) {
  const {
    method, url, body = '', accessKeyId, secretAccessKey, sessionToken,
    region, service, datetime = amzDate(), signContentSha256 = false,
    tokenAfterSigning = false,
  } = opts;
  if (!accessKeyId || !secretAccessKey) throw new Error('SigV4: an access key id and secret are required (fail closed).');
  if (!region || !service) throw new Error('SigV4: region and service are required.');
  const u = new URL(url);
  const payloadHash = await sha256Hex(typeof body === 'string' ? body : body ?? '');

  const headers = new Map();
  for (const [k, v] of Object.entries(opts.headers || {})) headers.set(k.toLowerCase(), trimHeaderValue(v));
  headers.set('host', u.host);
  headers.set('x-amz-date', datetime);
  if (signContentSha256) headers.set('x-amz-content-sha256', payloadHash);
  if (sessionToken && !tokenAfterSigning) headers.set('x-amz-security-token', sessionToken);

  const names = [...headers.keys()].sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers.get(n)}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri(u.pathname),
    canonicalQuery(u.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const date = datetime.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', datetime, scope, await sha256Hex(canonicalRequest)].join('\n');

  const kDate = await hmac(`AWS4${secretAccessKey}`, date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, 'aws4_request');
  const signature = hex(await hmac(kSigning, stringToSign));

  const out = Object.fromEntries(headers);
  if (sessionToken && tokenAfterSigning) out['x-amz-security-token'] = sessionToken;
  out.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  delete out.host; // fetch sets Host itself
  return { headers: out, canonicalRequest, stringToSign, signature };
}
