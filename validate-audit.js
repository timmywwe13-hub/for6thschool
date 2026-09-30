// Validates audit-undeclared.js by re-introducing the RIG bug in a temp copy.
const fs = require('fs');
const src = fs.readFileSync('index.html', 'utf8');
const injected = src.replace("root.name = 'playerCharacterRig';", 'root.name = RIG;');
if (injected === src) { console.log('VALIDATION FAILED: anchor not found'); process.exit(1); }
fs.writeFileSync('_rigtest.html', injected, 'utf8');
const { execFileSync } = require('child_process');
const outp = execFileSync(process.execPath, ['audit-undeclared.js', '_rigtest.html'], { encoding: 'utf8' });
fs.unlinkSync('_rigtest.html');
const caught = /RIG\s+\[constant/.test(outp);
console.log(caught ? 'VALIDATION OK: the audit catches the reintroduced RIG bug'
                   : 'VALIDATION FAILED: the audit missed it');
console.log(outp.split('\n').filter(l => l.indexOf('RIG') >= 0).join('\n'));
process.exit(caught ? 0 : 1);
