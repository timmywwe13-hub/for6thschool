# ISLE ROYALE - put the lobby on the internet for this session.
#
# Double-click PLAY-ONLINE.cmd (which runs this), and it:
#
#   1. starts the lobby on this machine,
#   2. opens a free Cloudflare tunnel to it - no account, no sign-in, no port
#      forwarding, and WebSockets work through it,
#   3. prints, copies and opens the ONE link to send everybody:
#
#          https://<random-words>.trycloudflare.com/?room=isle
#
# That link IS the game and the lobby: whoever opens it lands in the room with
# nothing to install - which is the whole point on school Chromebooks.
#
# The link is new every time this runs, so send it again each session. Leave the
# window open while people are playing; Ctrl-C (or closing it) takes it down.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$port = 8787
$room = 'isle'
$link = ''

function Say {
  param([string]$Text, [string]$Colour = 'Gray')
  Write-Host $Text -ForegroundColor $Colour
}

Say ''
Say '  ISLE ROYALE - putting the lobby online' 'Cyan'
Say '  ---------------------------------------------' 'DarkCyan'

# ---------- node ----------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Say '  Node.js is not installed on this machine.' 'Red'
  Say '  Install it once from https://nodejs.org/ (the LTS button), then try again.' 'Yellow'
  Say ''
  Read-Host '  Press Enter to close'
  exit 1
}

# ---------- a tunnel ----------
function Find-Tool {
  param([string]$Name)
  $cmd = Get-Command $Name -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $beside = Join-Path $root ($Name + '.exe')
  if (Test-Path $beside) { return $beside }
  return ''
}
$cloudflared = Find-Tool 'cloudflared'
$ngrok = Find-Tool 'ngrok'

if (-not $cloudflared -and -not $ngrok) {
  Say '  No tunnel tool found. Cloudflare one is free, needs no account, and is one command:' 'Yellow'
  Say ''
  Say '      winget install --id Cloudflare.cloudflared' 'White'
  Say ''
  $answer = Read-Host '  Install it now with winget? (y/N)'
  if ($answer -match '^(y|yes)$') {
    try {
      winget install --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements
      $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                  [System.Environment]::GetEnvironmentVariable('Path', 'User')
      $cloudflared = Find-Tool 'cloudflared'
    } catch {
      Say ('  winget failed: ' + $_.Exception.Message) 'Red'
    }
  }
  if (-not $cloudflared -and -not $ngrok) {
    Say '  Without a tunnel the game still works: PLAY-TOGETHER.cmd for the same wifi,' 'Yellow'
    Say '  or hand the folder round.' 'Yellow'
    Say ''
    Read-Host '  Press Enter to close'
    exit 1
  }
}

# ---------- the lobby ----------
Say ''
Say '  starting the lobby...'
$lobbyLog = Join-Path $env:TEMP 'isle-lobby.log'
$lobbyErr = Join-Path $env:TEMP 'isle-lobby.err'
$lobby = Start-Process -FilePath $node.Source -ArgumentList 'lobby-server.js' `
  -WorkingDirectory $root -PassThru -WindowStyle Minimized `
  -RedirectStandardOutput $lobbyLog -RedirectStandardError $lobbyErr

$up = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 400
  try {
    $probe = Invoke-WebRequest -Uri "http://127.0.0.1:$port/relay.json" -UseBasicParsing -TimeoutSec 2
    if ($probe.StatusCode -eq 200) { $up = $true; break }
  } catch { }
}
if (-not $up) {
  Say '  the lobby did not answer on port 8787' 'Red'
  Say "  its output is in $lobbyLog"
  if (Test-Path $lobbyLog) {
    Get-Content $lobbyLog | Select-Object -Last 10 | ForEach-Object { Say "    $_" }
  }
  Say ''
  Read-Host '  Press Enter to close'
  if ($lobby -and -not $lobby.HasExited) { $lobby | Stop-Process -Force }
  exit 1
}
Say '  lobby is up on this machine (port 8787)'

# ---------- the tunnel ----------
$tunnel = $null
$tunnelLog = Join-Path $env:TEMP 'isle-tunnel.log'
$tunnelErr = Join-Path $env:TEMP 'isle-tunnel.err'
if ($cloudflared) {
  Say '  opening the tunnel (cloudflared)...'
  Remove-Item $tunnelLog -ErrorAction SilentlyContinue
  Remove-Item $tunnelErr -ErrorAction SilentlyContinue
  # cloudflared prints its URL on stderr; the two logs cannot share one file
  $tunnel = Start-Process -FilePath $cloudflared `
    -ArgumentList 'tunnel', '--url', "http://127.0.0.1:$port", '--no-autoupdate' `
    -RedirectStandardOutput $tunnelLog -RedirectStandardError $tunnelErr -PassThru -NoNewWindow
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    $text = ''
    if (Test-Path $tunnelLog) { $text += [string](Get-Content $tunnelLog -Raw -ErrorAction SilentlyContinue) }
    if (Test-Path $tunnelErr) { $text += [string](Get-Content $tunnelErr -Raw -ErrorAction SilentlyContinue) }
    $m = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($m.Success) { $link = $m.Value; break }
    if ($tunnel.HasExited) { break }
  }
} else {
  Say '  opening the tunnel (ngrok)...'
  Say '  note: ngrok free plan shows a one-time "Visit site" click to visitors.' 'DarkYellow'
  $tunnel = Start-Process -FilePath $ngrok -ArgumentList 'http', $port.ToString() -PassThru -NoNewWindow
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $api = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2
      $https = $api.tunnels | Where-Object { $_.public_url -like 'https://*' } | Select-Object -First 1
      if ($https) { $link = $https.public_url; break }
    } catch { }
  }
}

# ---------- the link ----------
if (-not $link) {
  Say ''
  Say '  the tunnel did not come up. Its log, last lines:' 'Red'
  foreach ($file in @($tunnelLog, $tunnelErr)) {
    if (Test-Path $file) {
      Get-Content $file | Select-Object -Last 8 | ForEach-Object { Say "    $_" }
    }
  }
  Say ''
  Say '  The lobby is still running for this wifi: PLAY-TOGETHER.cmd prints the LAN link.' 'Yellow'
} else {
  $invite = $link + '/?room=' + $room
  Say ''
  Say '  =============================================' 'Green'
  Say '   THE LINK TO SEND EVERYBODY:' 'Green'
  Say ''
  Say "   $invite" 'White'
  Say ''
  Say '  =============================================' 'Green'
  try { Set-Clipboard -Value $invite } catch { }
  Say '  (copied to the clipboard - Discord, email, Classroom, anything)'
  # ISLE_NO_BROWSER=1 keeps a harness run (or a curious shell) from opening a tab
  if (-not $env:ISLE_NO_BROWSER) {
    try { Start-Process $invite } catch { }
    Say '  opened it in your browser, so this machine is in the lobby too.'
  }
  Say ''
  Say '  Leave this window open while people are playing. Ctrl-C stops it.' 'Yellow'
}

# ---------- hold, then clean up ----------
try {
  while ($true) {
    Start-Sleep -Seconds 3
    if ($tunnel -and $tunnel.HasExited) { Say '  the tunnel stopped.' 'Yellow'; break }
    if ($lobby -and $lobby.HasExited) { Say '  the lobby stopped.' 'Yellow'; break }
  }
} finally {
  if ($tunnel -and -not $tunnel.HasExited) { $tunnel | Stop-Process -Force -ErrorAction SilentlyContinue }
  if ($lobby -and -not $lobby.HasExited) { $lobby | Stop-Process -Force -ErrorAction SilentlyContinue }
  Say ''
  Say '  stopped. Nothing of this machine is on the internet any more.' 'Cyan'
}


