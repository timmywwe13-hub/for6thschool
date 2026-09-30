// Did the deploy folder carry the Supabase project?
//
// The whole online path rests on one fact: `node tools/web-build.js` puts the two
// environment variables into web/index.html, so the plain link a player opens is
// already in the lobby. This is the check for that fact, run by the GitHub
// workflow after every build (and by hand, if you like):
//
//   node tools/web-build.js && node tools/verify-bake.js
//
// With no ISLE_SUPABASE_URL in the environment it says so and passes - a fork or
// a pull request has no repository secrets, and the recipe still deserves a
// check. With one, the build must carry it, or that deploy would come up OFFLINE
// and nobody would know until a friend asked why the request never arrived.
const fs = require('fs');
const path = require('path');

const page = path.join(__dirname, '..', 'web', 'index.html');
const url = process.env.ISLE_SUPABASE_URL || '';
const key = process.env.ISLE_SUPABASE_KEY || '';

if (!url) {
  console.log('no ISLE_SUPABASE_URL in the environment - recipe checked, bake skipped.');
  process.exit(0);
}
if (!fs.existsSync(page)) {
  console.error('web/index.html does not exist: run node tools/web-build.js first.');
  process.exit(1);
}
const html = fs.readFileSync(page, 'utf8');
const missing = [];
if (html.indexOf(url) < 0) missing.push('ISLE_SUPABASE_URL');
if (key && html.indexOf(key) < 0) missing.push('ISLE_SUPABASE_KEY');
if (missing.length) {
  console.error('web/index.html does not carry ' + missing.join(' and ') +
    ': that deploy would come up OFFLINE.');
  console.error('Both are needed together - see netlify.toml, or DEPLOY-ONLINE.md section 1.');
  process.exit(1);
}
console.log('web/index.html carries the Supabase project: ' + url +
  (key ? ' (and its key)' : ''));
