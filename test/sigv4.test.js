// SigV4 against AWS's published test suite (aws-sig-v4-test-suite, as
// vendored in botocore/tests/unit/auth/aws4_testsuite). Credentials, region,
// service, and date are the suite's fixed values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { signRequest, canonicalUri, uriEncode } from '../src/sigv4.js';

const CREDS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 'service', datetime: '20150830T123600Z' };
const HOST = 'https://example.amazonaws.com';

const VECTORS = [
  { name: 'get-vanilla', method: 'GET', path: '/', sig: '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31' },
  { name: 'post-vanilla', method: 'POST', path: '/', sig: '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b' },
  { name: 'get-vanilla-query-order-key-case', method: 'GET', path: '/?Param2=value2&Param1=value1', sig: 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500' },
  { name: 'get-vanilla-empty-query-key', method: 'GET', path: '/?Param1=value1', sig: 'a67d582fa61cc504c4bae71f336f98b97f1ea3c7a6bfe1b6e45aec72011b9aeb' },
  { name: 'post-vanilla-query', method: 'POST', path: '/?Param1=value1', sig: '28038455d6de14eafc1f9222cf5aa6f1a96197d7deb8263271d420d138af7f11' },
  { name: 'get-vanilla-query-unreserved', method: 'GET', path: '/?-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz=-._~0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', sig: '9c3e54bfcdf0b19771a7f523ee5669cdf59bc7cc0884027167c21bb143a40197' },
  { name: 'get-vanilla-utf8-query', method: 'GET', path: '/?ሴ=bar', sig: '2cdec8eed098649ff3a119c94853b13c643bcf08f8b0a1d91e12c9027818dd04' },
  { name: 'get-vanilla-query-order-encoded', method: 'GET', path: '/?Param-3=Value3&Param=Value2&%E1%88%B4=Value1', sig: '371d3713e185cc334048618a97f809c9ffe339c62934c032af5a0e595648fcac' },
  { name: 'post-header-key-sort', method: 'POST', path: '/', headers: { 'My-Header1': 'value1' }, sig: 'c5410059b04c1ee005303aed430f6e6645f61f4dc9e1461ec8f8916fdf18852c' },
  { name: 'get-header-value-trim', method: 'GET', path: '/', headers: { 'My-Header1': ' value1', 'My-Header2': ' "a   b   c"' }, sig: 'acc3ed3afb60bb290fc8d2dd0098b9911fcaa05412b367055dee359757a9c736' },
  { name: 'post-x-www-form-urlencoded', method: 'POST', path: '/', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'Param1=value1', sig: 'ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a' },
  { name: 'get-vanilla-with-session-token', method: 'GET', path: '/', sessionToken: '6e86291e8372ff2a2260956d9b8aae1d763fbf315fa00fa31553b73ebf194267', sig: '07ec1639c89043aa0e3e2de82b96708f198cceab042d4a97044c66dd9f74e7f8' },
  // post-sts-header-after: the token is added AFTER signing, so the signature equals post-vanilla.
  { name: 'post-sts-header-after', method: 'POST', path: '/', sessionToken: 'AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI/qkPpKPi/kMcGdQrmGdeehM4IC1NtBmUpp2wUE8phUZampKsburEDy0KPkyQDYwT7WZ0wq5VSXDvp75YU9HFvlRd8Tx6q6fE8YQcHNVXAkiY9q6d+xo0rKwT38xVqr7ZD0u0iPPkUL64lIZbqBAz+scqKmlzm8FDrypNC9Yjc8fPOLn9FX9KSYvKTr4rvx3iSIlTJabIQwj2ICCR/oLxBA==', after: true, sig: '5da7c1a2acd57cee7505fc6676e4e544621c30862966e37dddb68e92efbe5d6b' },
];

for (const v of VECTORS) {
  test(`SigV4 test suite: ${v.name}`, async () => {
    const out = await signRequest({ ...CREDS, method: v.method, url: HOST + v.path, headers: v.headers, body: v.body ?? '', sessionToken: v.sessionToken, tokenAfterSigning: v.after });
    assert.equal(out.signature, v.sig);
    assert.match(out.headers.authorization, new RegExp(`^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=${v.sig}$`));
    if (v.sessionToken) assert.equal(out.headers['x-amz-security-token'], v.sessionToken);
  });
}

test('SigV4 canonical request for get-vanilla matches the suite .creq byte for byte', async () => {
  const out = await signRequest({ ...CREDS, method: 'GET', url: `${HOST}/` });
  assert.equal(out.canonicalRequest, 'GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(out.stringToSign, 'AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63');
});

test('SigV4 normalize-path vectors (get-slashes, get-relative-relative)', () => {
  assert.equal(canonicalUri('//example//'), '/example/');
  assert.equal(canonicalUri('/example1/example2/../..'), '/');
  assert.equal(canonicalUri('/./'), '/');
  assert.equal(canonicalUri('/contact-flows/11111111-2222-4333-8444-555555555555'), '/contact-flows/11111111-2222-4333-8444-555555555555');
});

test('RFC 3986 encoding covers the characters encodeURIComponent leaves alone', () => {
  assert.equal(uriEncode("!'()*"), '%21%27%28%29%2A');
  assert.equal(uriEncode('-._~'), '-._~');
  assert.equal(uriEncode('a b'), 'a%20b');
});

test('SigV4 fails closed without credentials', async () => {
  await assert.rejects(signRequest({ ...CREDS, accessKeyId: '', method: 'GET', url: `${HOST}/` }), /fail closed/);
  await assert.rejects(signRequest({ ...CREDS, secretAccessKey: '', method: 'GET', url: `${HOST}/` }), /fail closed/);
});
