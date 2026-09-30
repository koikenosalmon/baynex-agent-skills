import test from 'node:test';
import assert from 'node:assert/strict';
import { countApiDevelopmentCertificates, developmentCertificateAdvice, DEV_CERT_WARN_THRESHOLD } from './development-certificates.mjs';

const cert = (certificateType, name) => ({ attributes: { certificateType, name } });
const clientOf = (data) => ({ list: async (path) => { clientOf.path = path; return data; } });

test('counts only development certificates created via the API', async () => {
  const data = [cert('IOS_DEVELOPMENT', 'Created via API'), cert('DEVELOPMENT', 'Created via API'), cert('DEVELOPMENT', 'Jane Doe'), cert('DISTRIBUTION', 'Created via API')];
  const result = await countApiDevelopmentCertificates(clientOf(data));
  assert.deepEqual(result, { development: 3, api: 2, warn: false, threshold: DEV_CERT_WARN_THRESHOLD });
  assert.match(clientOf.path, /certificateType%5D=DEVELOPMENT,IOS_DEVELOPMENT/);
});

test('warns from the threshold on', async () => {
  const below = await countApiDevelopmentCertificates(clientOf(Array.from({ length: 4 }, () => cert('IOS_DEVELOPMENT', 'Created via API'))));
  const at = await countApiDevelopmentCertificates(clientOf(Array.from({ length: 5 }, () => cert('IOS_DEVELOPMENT', 'Created via API'))));
  assert.equal(below.warn, false);
  assert.equal(at.warn, true);
  assert.equal(DEV_CERT_WARN_THRESHOLD, 5);
  assert.match(developmentCertificateAdvice(at), /5 件/);
});

test('the module never revokes', async () => {
  const requests = [];
  await countApiDevelopmentCertificates({ list: async () => [], request: async (...args) => requests.push(args) });
  assert.equal(requests.length, 0);
});
