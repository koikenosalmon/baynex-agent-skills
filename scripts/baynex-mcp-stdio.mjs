#!/usr/bin/env node

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const BAYNEX_MCP_ENDPOINT = 'https://preview.baynex.jp/mcp';
const MAX_MESSAGE_BYTES = 4_000_000;
const DEFAULT_TIMEOUT_MS = 30_000;

function firstValue(env, names) {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return '';
}

export function credentialsFrom(env = process.env) {
  const accessClientId = firstValue(env, [
    'BAYNEX_MCP_ACCESS_CLIENT_ID',
    'BAYNEX_MCP_WRITE_ACCESS_CLIENT_ID',
    'CLOUDFLARE_ACCESS_CLIENT_ID',
  ]);
  const accessClientSecret = firstValue(env, [
    'BAYNEX_MCP_ACCESS_CLIENT_SECRET',
    'BAYNEX_MCP_WRITE_ACCESS_CLIENT_SECRET',
    'CLOUDFLARE_ACCESS_CLIENT_SECRET',
  ]);
  const token = firstValue(env, [
    'BAYNEX_MCP_TOKEN',
    'BAYNEX_MCP_WRITE_TOKEN',
    'MCP_BAYNEX_SPECIFICATIONS_WRITE_API_KEY',
    'HERMES_SLACK_BRIDGE_TOKEN',
  ]);
  if (!accessClientId) throw new Error('missing credential: BAYNEX_MCP_ACCESS_CLIENT_ID');
  if (!accessClientSecret) throw new Error('missing credential: BAYNEX_MCP_ACCESS_CLIENT_SECRET');
  if (!token) throw new Error('missing credential: BAYNEX_MCP_TOKEN');
  return { accessClientId, accessClientSecret, token };
}

function remoteErrorMessage(body) {
  try {
    const parsed = JSON.parse(body);
    const message = parsed?.error?.message || parsed?.error;
    if (typeof message === 'string' && message.trim()) return message.slice(0, 500);
  } catch {}
  return 'remote MCP request failed';
}

export function parseEventStream(body) {
  const messages = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    messages.push(JSON.parse(data));
  }
  return messages;
}

function validateEndpoint(endpoint) {
  const parsed = new URL(endpoint);
  if (parsed.protocol !== 'https:') throw new Error('Baynex MCP endpoint must use HTTPS');
  return parsed.toString();
}

async function withinDeadline(operation, deadline, controller) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    controller.abort();
    throw new Error('remote MCP request timed out');
  }
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('remote MCP request timed out'));
        }, remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export class BaynexRemoteTransport {
  constructor({
    env = process.env,
    fetchImpl = globalThis.fetch,
    endpoint = BAYNEX_MCP_ENDPOINT,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeout must be a positive integer');
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.endpoint = validateEndpoint(endpoint);
    this.timeoutMs = timeoutMs;
    this.sessionId = '';
  }

  async forward(message) {
    const { accessClientId, accessClientSecret, token } = credentialsFrom(this.env);
    const controller = new AbortController();
    const deadline = Date.now() + this.timeoutMs;
    let response;
    try {
      response = await withinDeadline(this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${token}`,
          'cf-access-client-id': accessClientId,
          'cf-access-client-secret': accessClientSecret,
          'content-type': 'application/json; charset=utf-8',
          ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
          'user-agent': 'baynex-agent-skills/0.1.0',
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      }), deadline, controller);
    } catch (error) {
      if (error?.name === 'AbortError' || error?.message === 'remote MCP request timed out') {
        throw new Error('remote MCP request timed out');
      }
      throw new Error(`remote MCP transport failed: ${error?.message || 'unknown error'}`);
    }

    const nextSession = response.headers.get('mcp-session-id');
    if (nextSession) this.sessionId = nextSession;
    if (response.status === 202) return [];

    const body = await withinDeadline(response.text(), deadline, controller);
    if (Buffer.byteLength(body, 'utf8') > MAX_MESSAGE_BYTES) throw new Error('remote MCP response is too large');
    if (!response.ok) throw new Error(`remote MCP HTTP ${response.status}: ${remoteErrorMessage(body)}`);
    if (!body.trim()) return [];

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) return [JSON.parse(body)];
    if (contentType.includes('text/event-stream')) return parseEventStream(body);
    throw new Error(`remote MCP returned unsupported content type: ${contentType || 'missing'}`);
  }
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function validRequest(message) {
  return message && typeof message === 'object' && !Array.isArray(message)
    && message.jsonrpc === '2.0' && typeof message.method === 'string' && message.method.length > 0;
}

export async function runStdio({ input = process.stdin, output = process.stdout, errorOutput = process.stderr, transport = new BaynexRemoteTransport() } = {}) {
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      if (Buffer.byteLength(line, 'utf8') > MAX_MESSAGE_BYTES) throw new Error('message too large');
      message = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify(errorResponse(null, -32700, 'Parse error'))}\n`);
      continue;
    }
    if (!validRequest(message)) {
      output.write(`${JSON.stringify(errorResponse(message?.id, -32600, 'Invalid Request'))}\n`);
      continue;
    }
    try {
      const responses = await transport.forward(message);
      for (const response of responses) output.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      const text = error?.message || 'remote MCP error';
      if (Object.hasOwn(message, 'id')) output.write(`${JSON.stringify(errorResponse(message.id, -32000, text))}\n`);
      else errorOutput.write(`Baynex MCP notification failed: ${text}\n`);
    }
  }
}

export async function verify({ transport = new BaynexRemoteTransport(), output = process.stdout } = {}) {
  const initialization = await transport.forward({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'baynex-agent-skills', version: '0.1.0' } },
  });
  const initialized = initialization.find((item) => item?.id === 1);
  if (!initialized || initialized.error || !initialized.result?.serverInfo?.name) throw new Error('Baynex MCP initialization failed');
  await transport.forward({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const listing = await transport.forward({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = listing.find((item) => item?.id === 2)?.result?.tools;
  if (!Array.isArray(tools)) throw new Error('Baynex MCP tool discovery failed');
  output.write(`${JSON.stringify({
    ok: true,
    server: initialized.result.serverInfo,
    protocolVersion: initialized.result.protocolVersion,
    tools: tools.map((tool) => tool.name),
  }, null, 2)}\n`);
}

async function main() {
  if (process.argv[2] === '--verify') await verify();
  else await runStdio();
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`Baynex MCP adapter error: ${error?.message || 'unknown error'}\n`);
    process.exitCode = 1;
  });
}
