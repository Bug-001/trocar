// test/dissect/vendors.test.mjs — D37 third axis: vendor from the upstream host (3.2:50).
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostOf, vendorOf } from '../../src/dissect/vendors.mjs';

test('vendor comes from the upstream host (3.2:50), never from the wire format or harness', () => {
  const v = (host) => vendorOf({ host });
  assert.deepEqual(
    ['api.anthropic.com', 'api.openai.com', 'chatgpt.com', 'api.deepseek.com', 'api.moonshot.cn', 'api.kimi.com', 'open.bigmodel.cn', 'api.z.ai', 'openrouter.ai', 'relay.example.com'].map(v),
    ['anthropic', 'openai', 'openai', 'deepseek', 'moonshot', 'moonshot', 'zai', 'zai', 'openrouter', null]);
  // the harness and the wire do not move the vendor: dsh on the Anthropic wire is still DeepSeek's
  assert.equal(vendorOf({ host: 'api.deepseek.com', endpoint: '/anthropic/v1/messages', proc: { agent: 'claude-code' } }), 'deepseek');
  assert.equal(vendorOf({ host: 'evil-anthropic.com' }), null, 'a suffix match needs a dot boundary');
});

test('hostOf: the collector host wins; legacy records fall back to Host (port and case stripped)', () => {
  assert.equal(hostOf({ host: 'API.DeepSeek.com', req_headers: { host: 'x' } }), 'api.deepseek.com');
  assert.equal(hostOf({ req_headers: { Host: 'api.anthropic.com:443' } }), 'api.anthropic.com');
  assert.equal(hostOf({ req_headers: { host: '[::1]:9811' } }), '::1');
  assert.equal(hostOf({ req_headers: {} }), null);
  assert.equal(vendorOf({ req_headers: { host: '127.0.0.1:9811' } }), null, 'a loopback relay names no vendor (gate G5)');
});
