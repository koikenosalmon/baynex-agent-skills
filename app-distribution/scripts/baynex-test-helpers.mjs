// Shared fakes for the Baynex CI tests (not a test file).
export const json = (data, status = 200) => ({ ok: status < 300, status, json: async () => data });
export const oidcEnv = { ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.test/oidc?api=1', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'request-secret' };
// Serves GitHub's OIDC endpoint (a fresh token per request) and delegates Baynex requests to `baynex`.
export function fakeFetch(baynex) {
  const calls = { oidc: [], baynex: [] };
  let counter = 0;
  const fetch = async (url, options = {}) => {
    const address = String(url);
    if (address.startsWith('https://token.actions.test/')) {
      calls.oidc.push({ url: address, headers: options.headers });
      return json({ value: `oidc-token-${++counter}` });
    }
    calls.baynex.push({ url: address, options });
    return baynex(address, options);
  };
  return { fetch, calls };
}

