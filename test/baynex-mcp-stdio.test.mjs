import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BaynexRemoteTransport,
  credentialsFrom,
  parseEventStream,
} from '../scripts/baynex-mcp-stdio.mjs';

const credentials = {
  BAYNEX_MCP_ACCESS_CLIENT_ID: 'access-id',
  BAYNEX_MCP_ACCESS_CLIENT_SECRET: 'access-secret',
  BAYNEX_MCP_TOKEN: 'bridge-token',
};

test('requires all three credentials without contacting the network', async () => {
  assert.throws(() => credentialsFrom({}), /BAYNEX_MCP_ACCESS_CLIENT_ID/);
  let calls = 0;
  const transport = new BaynexRemoteTransport({
    env: {},
    endpoint: 'https://example.test/mcp',
    fetchImpl: async () => { calls += 1; return new Response(); },
  });
  await assert.rejects(() => transport.forward({ jsonrpc: '2.0', id: 1, method: 'initialize' }), /missing credential/);
  assert.equal(calls, 0);
});

test('forwards authentication headers and retains the MCP session id', async () => {
  const requests = [];
  const transport = new BaynexRemoteTransport({
    env: credentials,
    endpoint: 'https://example.test/mcp',
    fetchImpl: async (_url, options) => {
      requests.push(new Headers(options.headers));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: requests.length, result: {} }), {
        headers: {
          'content-type': 'application/json',
          ...(requests.length === 1 ? { 'mcp-session-id': 'session-1' } : {}),
        },
      });
    },
  });
  await transport.forward({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  await transport.forward({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(requests[0].get('authorization'), 'Bearer bridge-token');
  assert.equal(requests[0].get('cf-access-client-id'), 'access-id');
  assert.equal(requests[0].get('cf-access-client-secret'), 'access-secret');
  assert.equal(requests[1].get('mcp-session-id'), 'session-1');
});

test('parses Streamable HTTP event streams and ignores the done marker', () => {
  const messages = parseEventStream([
    'event: message',
    'data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}',
    '',
    'data: [DONE]',
    '',
  ].join('\n'));
  assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 1, result: { ok: true } }]);
});

test('rejects an insecure endpoint before any request', () => {
  assert.throws(() => new BaynexRemoteTransport({
    env: credentials,
    endpoint: 'http://example.test/mcp',
    fetchImpl: async () => new Response(),
  }), /must use HTTPS/);
});

test('does not emit a body for accepted notifications', async () => {
  const transport = new BaynexRemoteTransport({
    env: credentials,
    endpoint: 'https://example.test/mcp',
    fetchImpl: async () => new Response(null, { status: 202 }),
  });
  assert.deepEqual(await transport.forward({ jsonrpc: '2.0', method: 'notifications/initialized' }), []);
});

test('enforces one deadline across fetch and response parsing', async () => {
  const hangingFetch = new BaynexRemoteTransport({
    env: credentials,
    endpoint: 'https://example.test/mcp',
    timeoutMs: 10,
    fetchImpl: async () => new Promise(() => {}),
  });
  await assert.rejects(() => hangingFetch.forward({ jsonrpc: '2.0', id: 1, method: 'initialize' }), /timed out/);

  const hangingBody = new BaynexRemoteTransport({
    env: credentials,
    endpoint: 'https://example.test/mcp',
    timeoutMs: 10,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => new Promise(() => {}),
    }),
  });
  await assert.rejects(() => hangingBody.forward({ jsonrpc: '2.0', id: 1, method: 'initialize' }), /timed out/);
});
