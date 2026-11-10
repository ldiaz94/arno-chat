// Copies the design test's screenshots that the README shows into doc/img/,
// after `npm run test:design` has made them in /tmp. Run with
// `npm run screenshots`; the pictures come from the test's fixed data, so they
// are the same each time but for the clock.
const fs = require('node:fs');
const path = require('node:path');
const SHOTS = {
  'arno-chat-home-mobile.png': 'chat-home.png',
  'arno-streaming-mobile.png': 'chat-streaming.png',
  'arno-approval-mobile.png': 'chat-approval.png',
  'arno-jump-mobile.png': 'code-session.png',
  'arno-code-history-390-dark.png': 'code-history.png',
  'arno-code-file-390-dark.png': 'code-file.png',
  'arno-code-options.png': 'code-options.png',
  'arno-commands.png': 'code-commands.png',
  'arno-details-folded.png': 'details.png',
  'arno-connections-mobile.png': 'connections.png',
};
const into = path.join(__dirname, '..', 'doc', 'img');
for (const [from, to] of Object.entries(SHOTS))
  fs.copyFileSync('/tmp/' + from, path.join(into, to));
console.log('copied', Object.keys(SHOTS).length, 'screenshots to doc/img');
