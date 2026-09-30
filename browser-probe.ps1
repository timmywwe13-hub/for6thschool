# Headless-browser scenario runner that needs no Node install.
#
# cdp-test.js is the real harness (Node + the DevTools protocol). This script is
# the fallback for a machine that only has Chrome/Edge: it compiles
# index.html + scenarios/<name>.js into one throwaway page (playtest/_probe.html)
# and lets the BROWSER run the scenario itself behind a tiny CommonJS shim, then
# reads the result back out of the DOM with --dump-dom.
#
# Usage:  powershell -NoProfile -File browser-probe.ps1 -Scenario chests
#         powershell -NoProfile -File browser-probe.ps1 -Scenario surfmesh -BudgetMs 120000
param(
  [Parameter(Mandatory = $true)][string]$Scenario,
  [int]$BudgetMs = 30000,
  [int]$TimeoutSec = 180
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$scenarioPath = Join-Path $root ("scenarios\{0}.js" -f $Scenario)
if (-not (Test-Path $scenarioPath)) { throw "no such scenario: $scenarioPath" }

$html = Get-Content (Join-Path $root 'index.html') -Raw
$scen = Get-Content $scenarioPath -Raw

# The error hook has to sit in front of the game script: a syntax error in the
# single giant inline block is otherwise invisible to the probe.
$hook = @'
<script>window.__errs=[];
window.addEventListener('error', function(e){ window.__errs.push('onerror: ' + e.message + ' @' + e.lineno + ':' + e.colno); });
window.addEventListener('unhandledrejection', function(e){ window.__errs.push('unhandledrejection: ' + ((e.reason && e.reason.message) || e.reason)); });
(function(){ var ce = console.error; console.error = function(a){ window.__errs.push('console.error: ' + a); return ce.apply(console, arguments); }; })();
</script>
'@
$html = $html.Replace('<head>', "<head>`r`n$hook")

$runner = @'
<pre id="probeout" style="position:fixed;left:-9999px">running</pre>
<script>
(function () {
  var R = { checks: [], logs: [], errs: [], done: false };
  window.__probe = R;
  function push(level) {
    return function () {
      R.logs.push(level + ': ' + Array.prototype.map.call(arguments, function (a) {
        return (a === undefined) ? 'undefined' : String(a);
      }).join(' '));
    };
  }
  var clog = console.log, cinfo = console.info, cwarn = console.warn;
  console.log = function () { push('log').apply(null, arguments); clog.apply(console, arguments); };
  console.info = function () { push('log').apply(null, arguments); cinfo.apply(console, arguments); };
  console.warn = function () { push('warn').apply(null, arguments); cwarn.apply(console, arguments); };

  /* the scenario files are CommonJS: hand them a module object and take the
     exported function back out (they never require() anything) */
  var module = { exports: {} };
  (function (module, exports) {
__SCENARIO__
  })(module, module.exports);
  var scenario = module.exports;

  function render() {
    var out = document.getElementById('probeout');
    if (out) out.textContent = JSON.stringify(R);
  }

  function boot(cb) {
    var tries = 0;
    (function poll() {
      tries++;
      var ok = false;
      try {
        ok = typeof App !== 'undefined' && App.state === 'MENU' &&
             document.getElementById('bootLoading').classList.contains('hidden');
      } catch (e) { ok = false; }
      if (ok || tries > 240) { render(); cb(); return; }
      setTimeout(poll, 250);
    })();
  }

  var ctx = {
    /* the harness evaluates a string in page scope; indirect eval does the same */
    evaluate: function (expr) {
      try { return Promise.resolve((0, eval)(expr)); }
      catch (e) { return Promise.reject(e); }
    },
    check: function (name, ok, detail) {
      R.checks.push({ name: name, ok: !!ok, detail: (detail === undefined) ? '' : String(detail) });
      render();
    },
    sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    logs: R.logs, notes: R.logs,
    send: function () { return Promise.resolve({}); }
  };

  boot(function () {
    /* Stop the game's own render loop now that it has booted. Under
       --virtual-time-budget an endless requestAnimationFrame chain keeps the
       virtual clock busy one software-GL frame at a time, which turns a 90 s
       budget into minutes of wall clock. Scenarios drive Game.update()
       directly, so the loop is dead weight here. */
    window.requestAnimationFrame = function () { return 0; };
    var run;
    try { run = scenario(ctx); }
    catch (e) {
      R.checks.push({ name: 'scenario ran without throwing', ok: false, detail: String(e && e.message || e) });
      R.fatal = String(e && (e.stack || e.message) || e);
      R.done = true; render(); return;
    }
    Promise.resolve(run).catch(function (e) {
      R.checks.push({ name: 'scenario ran without throwing', ok: false, detail: String(e && e.message || e) });
      R.fatal = String(e && (e.stack || e.message) || e);
    }).then(function () {
      try { R.errs = (window.__errs || []).slice(0, 40); } catch (e) { /* ignore */ }
      R.done = true; render();
    });
  });
})();
</script>
'@
$runner = $runner.Replace('__SCENARIO__', $scen)
$html = $html.Replace('</body>', "$runner`r`n</body>")


# The probe page has to sit NEXT TO index.html: the game loads freddy_anims.js,
# vendor/GLTFLoader.js and the model sidecar by relative path.
$outPath = Join-Path $root '_probe.html'
Set-Content -Path $outPath -Value $html -Encoding UTF8

$browsers = @(
  (Join-Path $env:PROGRAMFILES 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:PROGRAMFILES 'Microsoft\Edge\Application\msedge.exe')
)
$exe = $browsers | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $exe) { throw 'no Chrome/Edge found' }

$profile = Join-Path $root 'playtest\_probe-profile'
$dump = Join-Path $root 'playtest\_probe-dom.html'
$errFile = Join-Path $root 'playtest\_probe-dom.err'
Remove-Item $dump, $errFile -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue
$url = 'file:///' + $outPath.Replace('\', '/')

# Chrome's launcher forks the real browser and returns straight away, so the
# dump can only be collected from a FILE handle the child inherited - piping it
# into a PowerShell variable comes back empty.
$chromeArgs = @('--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader', '--no-sandbox',
  '--disable-extensions', '--mute-audio', '--no-first-run', '--no-default-browser-check',
  ('--user-data-dir=' + $profile), ('--virtual-time-budget=' + $BudgetMs), '--dump-dom', $url)
$proc = Start-Process -FilePath $exe -ArgumentList $chromeArgs -NoNewWindow -PassThru `
  -RedirectStandardOutput $dump -RedirectStandardError $errFile

$text = ''
for ($i = 0; $i -lt $TimeoutSec * 2; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-Path $dump) {
    $text = Get-Content $dump -Raw -ErrorAction SilentlyContinue
    if ($text -and $text.Contains('</html>')) { break }
  }
}
# close only the instance we started (a stray one would keep the profile lock)
Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like ('*' + $profile + '*') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item -Recurse -Force $profile -ErrorAction SilentlyContinue
if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }

if (-not $text) { Write-Output 'PROBE PRODUCED NO OUTPUT (the page never booted)'; Remove-Item $outPath -ErrorAction SilentlyContinue; exit 2 }
$m = [regex]::Match($text, '(?s)<pre id="probeout"[^>]*>(.*?)</pre>')
Remove-Item $outPath -ErrorAction SilentlyContinue
if (-not $m.Success) { Write-Output 'PROBE PRODUCED NO RESULT BLOCK'; exit 2 }

$json = $m.Groups[1].Value
$json = $json.Replace('&amp;', '&').Replace('&lt;', '<').Replace('&gt;', '>').Replace('&quot;', '"')
$r = $json | ConvertFrom-Json

if (-not $r.done) { Write-Output 'PROBE DID NOT FINISH (raise -BudgetMs)' }

$failed = 0
foreach ($c in $r.checks) {
  if ($c.ok) { Write-Output ("PASS  {0}" -f $c.name) }
  else { $failed++; Write-Output ("FAIL  {0}   [{1}]" -f $c.name, $c.detail) }
}
if ($r.fatal) { Write-Output ('FATAL ' + $r.fatal) }
if ($r.logs.Count) {
  Write-Output '--- scenario output ---'
  $r.logs | ForEach-Object { Write-Output ('  ' + $_) }
}
Write-Output '--- page errors ---'
if (-not $r.errs.Count) { Write-Output '  (clean)' } else { $r.errs | ForEach-Object { Write-Output ('  ' + $_) } }
Write-Output ("--- summary: {0}/{1} checks passed; {2} page error(s) ---" -f ($r.checks.Count - $failed), $r.checks.Count, $r.errs.Count)
exit ($failed + $r.errs.Count)
