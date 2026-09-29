// GitHub Actions OIDC client for the Baynex CI API (https://api.baynex.jp/ci/v1/*).
// Each OIDC token is single-use on the Baynex side, so every call requests a fresh one.
// Tokens and response bodies are never printed; only status codes and short error codes are.
export const BAYNEX_API = 'https://api.baynex.jp';
// Diagnostics and ::add-mask:: commands go to stderr: callers capture stdout (jq, $(...)) as machine-readable payload.
export const toStderr = (line) => { process.stderr.write(`${line}\n`); };
const codePattern = /^[a-z][a-z_]{0,40}$/;

export class BaynexError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
  // 401/403 mean this repository or workflow is not registered in Baynex.
  get denied() { return this.status === 401 || this.status === 403; }
}

async function withTimeout(fetchImpl, url, options, timeoutMs) {
  return fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

export async function fetchOidcToken(audience, { env = process.env, fetch: fetchImpl = fetch, print = toStderr, timeoutMs = 10000 } = {}) {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) throw new BaynexError('GitHub OIDC トークンを取得できません（workflow に permissions: id-token: write が必要です）', { code: 'oidc_unavailable' });
  let response;
  try {
    response = await withTimeout(fetchImpl, `${requestUrl}${requestUrl.includes('?') ? '&' : '?'}audience=${encodeURIComponent(audience)}`, { headers: { Authorization: `Bearer ${requestToken}`, Accept: 'application/json' } }, timeoutMs);
  } catch { throw new BaynexError('GitHub OIDC トークンの取得に失敗しました（通信エラー）', { code: 'oidc_network' }); }
  if (!response.ok) throw new BaynexError(`GitHub OIDC トークンの取得に失敗しました（HTTP ${response.status}）`, { status: response.status, code: 'oidc_failed' });
  let body;
  try { body = await response.json(); } catch { body = null; }
  const value = body?.value;
  if (typeof value !== 'string' || !value) throw new BaynexError('GitHub OIDC トークンの応答が不正です', { code: 'oidc_invalid' });
  print(`::add-mask::${value}`);
  return value;
}

// POSTs a JSON body to the Baynex CI API and returns the parsed JSON. Throws BaynexError otherwise.
export async function postBaynex(path, body, { env = process.env, fetch: fetchImpl = fetch, print = toStderr, timeoutMs = 15000, baseUrl = BAYNEX_API } = {}) {
  if (!/^\/ci\/v1\/[a-z-]+$/.test(path)) throw new Error('Baynex CI API のパスが不正です');
  const url = `${baseUrl}${path}`;
  const token = await fetchOidcToken(url, { env, fetch: fetchImpl, print, timeoutMs });
  let response;
  try {
    response = await withTimeout(fetchImpl, url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }, timeoutMs);
  } catch { throw new BaynexError(`Baynex ${path} に接続できません`, { code: 'network' }); }
  let data = null;
  try { data = await response.json(); } catch { /* handled below */ }
  if (!response.ok) {
    const code = typeof data?.error === 'string' && codePattern.test(data.error) ? data.error : '';
    throw new BaynexError(`Baynex ${path} が HTTP ${response.status}${code ? `（${code}）` : ''} を返しました`, { status: response.status, code });
  }
  if (!data || typeof data !== 'object') throw new BaynexError(`Baynex ${path} の応答が不正です`, { status: response.status, code: 'invalid_response' });
  return data;
}
