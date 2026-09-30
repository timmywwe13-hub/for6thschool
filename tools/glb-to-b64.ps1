# =====================================================================
# Packs a .glb into a classic script that hands the bytes to the page as
# base64:  freddy_fazzbear.glb  ->  freddy_fazzbear.glb.js
#
# Why: when index.html is opened straight off the disk (file://) the browser
# refuses to fetch()/XHR a sibling binary file, while <script src="..."> is
# always allowed. The game fetches the .glb when it can (http/https, or
# file:// with file access) and falls back to this sidecar.
#
# Usage:  powershell -NoProfile -File tools/glb-to-b64.ps1
#         (optional) -Glb other.glb -Global OTHER_B64 -Out other.glb.js
# =====================================================================
param(
  [string]$Glb = '',
  [string]$Global = 'FREDDY_GLB_B64',
  [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot
if (-not $Glb) { $Glb = Join-Path $proj 'freddy_fazzbear.glb' }
$Glb = [System.IO.Path]::GetFullPath($Glb)
if (-not (Test-Path $Glb)) { throw "no such file: $Glb" }
if (-not $Out) { $Out = $Glb + '.js' }
$Out = [System.IO.Path]::GetFullPath($Out)

$bytes = [System.IO.File]::ReadAllBytes($Glb)
# sanity: a .glb header declares its own total length - a mismatch means the
# file went through a text/binary conversion somewhere and is not loadable
if ($bytes.Length -lt 12 -or [Text.Encoding]::ASCII.GetString($bytes, 0, 4) -ne 'glTF') {
  throw "$([System.IO.Path]::GetFileName($Glb)) is not a binary glTF container (bad magic)"
}
$declared = [BitConverter]::ToUInt32($bytes, 8)
if ($declared -ne $bytes.Length) {
  Write-Warning ("GLB length mismatch: header says $declared bytes, the file has $($bytes.Length). " +
                 'The trailing bytes are ignored by the loader, but the file is worth re-exporting.')
}

Write-Host "packing $([System.IO.Path]::GetFileName($Glb)) ($([Math]::Round($bytes.Length / 1MB, 2)) MB) ..."
$b64 = [Convert]::ToBase64String($bytes)
$text = @"
/* $([System.IO.Path]::GetFileName($Glb)) as base64 - GENERATED, do not edit.
   Rebuild with:  powershell -NoProfile -File tools/glb-to-b64.ps1
   Only read by the game when the page is opened from file:// and the .glb
   itself cannot be fetched. Sets window.$Global.
   Model: $(($bytes | Measure-Object).Count) bytes. */
window.$Global = '$b64';
"@
[System.IO.File]::WriteAllText($Out, $text, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "wrote $Out ($([Math]::Round((Get-Item $Out).Length / 1MB, 2)) MB)"
