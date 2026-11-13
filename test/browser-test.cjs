// Exercise deployed HTML with the same API fixtures as the local design suite.
// This intentionally does not claim authenticated end-to-end provider coverage.
// ARNO_TEST_LIVE names the deployment, e.g. https://<worker>.<subdomain>.workers.dev.
if (!/^https:\/\//.test(process.env.ARNO_TEST_LIVE || '')) {
  console.error('Set ARNO_TEST_LIVE to the deployment URL (https://...).');
  process.exit(2);
}
require('./design-test.cjs');
