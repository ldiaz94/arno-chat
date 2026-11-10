// Exercise deployed HTML with the same API fixtures as the local design suite.
// This intentionally does not claim authenticated end-to-end provider coverage.
process.env.ARNO_TEST_LIVE = '1';
require('./design-test.cjs');
