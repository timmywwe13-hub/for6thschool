// The match now opens on the battle bus, so every scenario that used to click
// PLAY and then spin Game.update until the DROP phase ends has to ride the bus a
// little and then jump. This inserts that pair in front of each such wait, and is
// idempotent - it rewrites a line it has written before.
//
// The ride stops once the bus is over the island: jumping off the very start of
// the line drops the player in the sea, which is realistic but not what a probe
// wants to measure.
//
// Usage: node tools/fix-scenarios-bus.js [--dry]
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '..', 'scenarios');
const dry = process.argv.indexOf('--dry') > 0;
let files = 0, edits = 0;

const OLD = "if (App.state === 'BUS') Bus.jump();";
const NEW = "if (App.state === 'BUS') { for (var __b = 0; __b < 3000 && App.state === 'BUS' && " +
            "Math.hypot(Bus.pos.x, Bus.pos.z) > 290; __b++) Bus.update(1 / 60); Bus.jump(); }";
const WAIT = /App\.state === 'DROP'/;

for (const name of fs.readdirSync(dir)) {
  if (!/\.js$/.test(name)) continue;
  const file = path.join(dir, name);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const out = [];
  let added = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    /* rewrite a line this tool wrote on an earlier run */
    if (line.indexOf(OLD) >= 0 && line.indexOf('Bus.update') < 0) {
      out.push(line.replace(OLD, NEW));
      added++;
      continue;
    }
    const isWait = WAIT.test(line) && /for \(|if \(/.test(line) &&
                   /Game\.update|Player\.update/.test(line + (lines[i + 1] || ''));
    let prev = out.length - 1;
    while (prev >= 0 && out[prev].trim() === '') prev--;
    const haveJump = prev >= 0 && out[prev].indexOf('Bus.jump()') >= 0;
    if (isWait && !haveJump) {
      const indent = (/^[ \t]*/.exec(line) || [''])[0];
      out.push(indent + NEW);
      added++;
    }
    out.push(line);
  }

  if (added) {
    files++; edits += added;
    console.log('  ' + name + ': ' + added + ' site(s)');
    if (!dry) fs.writeFileSync(file, out.join('\n'));
  }
}
console.log((dry ? 'would patch ' : 'patched ') + files + ' file(s), ' + edits + ' site(s)');
