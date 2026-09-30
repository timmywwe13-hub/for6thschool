// suite.js - the full-playtest runner: every scenario in scenarios/ through the
// CDP harness, in parallel lanes, with a machine-readable result table.
//
//   node tools/suite.js                       -> every scenario, 3 lanes
//   node tools/suite.js skins teams duos      -> just those
//   node tools/suite.js --lanes=2             -> fewer browsers (a slow box)
//   node tools/suite.js --timeout=900000      -> per-scenario cap, ms
//
// Each scenario is a normal `node cdp-test.js <name>` run, so a failure here is
// exactly the failure you get by hand; the per-scenario output is kept in
// playtest/suite/<name>.log and the running table in playtest/suite-status.json
// (rewritten after every scenario, so a long run can be watched with Get-Content).
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCEN = path.join(ROOT, 'scenarios');
const LOGS = path.join(ROOT, 'playtest', 'suite');
const STATUS = path.join(ROOT, 'playtest', 'suite-status.json');
const REPORT = path.join(ROOT, 'playtest', 'suite-report.txt');

const arg = name => {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.split('=')[1] : null;
};
const ONLY = process.argv.slice(2).filter(a => !a.startsWith('--'));
const LANES = Math.max(1, Number(arg('lanes') || 3));
const TIMEOUT = Number(arg('timeout') || 900000);

/* the maintained scenarios first, then the scratch/one-off probes: a run that
   dies half way still says the most about the game */
const all = fs.readdirSync(SCEN).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3));
const picked = ONLY.length ? ONLY : all.sort((a, b) => (a[0] === '_') - (b[0] === '_') || a.localeCompare(b));

fs.mkdirSync(LOGS, { recursive: true });

const results = picked.map(name => ({ name, state: 'queued' }));
let done = 0;
function write() {
  const summary = {
    started: new Date().toISOString(), lanes: LANES,
    done: results.filter(r => r.state !== 'queued' && r.state !== 'running').length,
    total: results.length, cases: results
  };
  fs.writeFileSync(STATUS, JSON.stringify(summary, null, 1));
}
write();

function runOne(name) {
  return new Promise(resolve => {
    const child = execFile('node', ['cdp-test.js', name],
      /* no CDP_PORT: each browser picks its own debug port (see cdp-lib.js), so a
         browser that is still shutting down can never block the next one */
      { cwd: ROOT, env: process.env, timeout: TIMEOUT, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        fs.writeFileSync(path.join(LOGS, name + '.log'), stdout + stderr);
        /* the harness prints "N/M checks passed; K console problem(s)" and exits
           non-zero for either - parse the counts, they are the real verdict */
        const text = stdout + stderr;
        const m = /(\d+)\/(\d+) checks passed; (\d+) console problem/.exec(text);
        const failed = (text.match(/^\s+FAILED: .+$/gm) || []).map(s => s.trim().replace('FAILED: ', ''));
        resolve({
          pass: m ? Number(m[1]) : 0,
          checks: m ? Number(m[2]) : 0,
          problems: m ? Number(m[3]) : -1,
          names: failed,
          error: /SCENARIO ERROR|harness error/.test(text)
            ? (text.match(/^(?:SCENARIO ERROR|harness error): .+$/m) || [''])[0] : '',
          killed: !!err && err.killed
        });
      });
  });
}

/* a lane is a worker: it takes the next queued scenario and runs it, so at most
   LANES browsers are alive at once */
const lanes = [];
let cursor = 0;
async function worker() {
  while (cursor < picked.length) {
    const i = cursor++;
    const r = results[i];
    r.state = 'running';
    write();
    const t0 = Date.now();
    let res = await runOne(r.name);
    /* A run with no summary at all never got as far as the game (the browser
       failed to start, the box was thrashing). That is worth one more try, with
       the log kept only if the retry fails too. */
    if (res.checks === 0 && res.problems === -1 && !res.killed) {
      r.retried = true;
      res = await runOne(r.name);
    }
    Object.assign(r, res, { state: 'done', ms: Date.now() - t0 });
    done++;
    /* `checks === 0` with no console problems is a probe that only prints (it has
       no assertions to make), which is information, not a regression */
    if (res.checks === 0 && res.problems === 0) {
      console.log('INFO  ' + r.name.padEnd(16) + 'no assertions (diagnostic probe)   [' +
        Math.round(r.ms / 1000) + 's]');
      write();
      continue;
    }
    const ok = res.problems === 0 && res.checks > 0 && res.pass === res.checks;
    console.log((ok ? 'PASS  ' : 'FAIL  ') + r.name.padEnd(16) +
      (res.checks ? res.pass + '/' + res.checks + ' checks' : 'no summary') +
      (res.problems ? ', ' + res.problems + ' console problem(s)' : '') +
      (res.names.length ? ', ' + res.names.length + ' failed check(s)' : '') +
      (r.error ? ' | ' + r.error : '') + '   [' + Math.round(r.ms / 1000) + 's]' +
      (r.retried ? ' (retried)' : ''));
    write();
  }
}
for (let l = 0; l < LANES; l++) lanes[l] = worker();

(async () => {
  await Promise.all(lanes);
  /* A failure is a run that finished with a console problem or a failed check.
     A probe that only prints (checks === 0, clean console) is information, not a
     regression, so it does not count against the run. */
  const bad = results.filter(r => r.state === 'done' &&
    (r.problems !== 0 || r.pass !== r.checks));
  const needs = results.filter(r => r.state === 'done' && r.checks === 0 && r.problems !== 0);
  const lines = [];
  lines.push('FULL PLAYTEST - ' + new Date().toISOString());
  lines.push(picked.length + ' scenarios, ' + LANES + ' lane(s)');
  lines.push('');
  for (const r of results) {
    const info = r.state === 'done' && r.checks === 0 && r.problems === 0;
    const ok = r.state === 'done' && r.problems === 0 && r.checks > 0 && r.pass === r.checks;
    lines.push((info ? 'INFO  ' : ok ? 'PASS  ' : 'FAIL  ') + r.name.padEnd(16) +
      (r.checks ? r.pass + '/' + r.checks : info ? 'no assertions' : '-/-') + ' checks' +
      (r.problems ? ' | ' + r.problems + ' console problem(s)' : '') +
      (r.error ? ' | ' + r.error : ''));
    for (const n of (r.names || [])) lines.push('        FAILED CHECK: ' + n);
  }
  lines.push('');
  lines.push('verdict: ' + (bad.length ? bad.length + ' scenario(s) need work: ' +
    bad.map(r => r.name).join(', ') : 'all green') +
    (needs.length ? ' (' + needs.length + ' never reported)' : ''));
  const text = lines.join('\n') + '\n';
  fs.writeFileSync(REPORT, text);
  console.log('\n' + text);
  process.exit(bad.length ? 1 : 0);
})();
