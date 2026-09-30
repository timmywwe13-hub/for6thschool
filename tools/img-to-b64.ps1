# =====================================================================
# Packs a .png into a classic script that hands the bytes to the page as
# base64:  isle_map.png  ->  isle_map.png.js
#
# Why: when index.html is opened straight off the disk (file://) the browser
# refuses to fetch()/XHR a sibling file, while <script src="..."> is always
# allowed. The game loads the picture normally when it can (http/https) and
# falls back to this sidecar. The sidecar also keeps the map canvas untainted,
# which the minimap needs for its getImageData() readback.
#
# Usage:  powershell -NoProfile -File tools/img-to-b64.ps1
#         (optional) -Img other.png -Global OTHER_B64 -Out other.png.js
# =====================================================================
param(
  [string]$Img = '',
  [string]$Global = 'ISLE_MAP_B64',
  [string]$Out = ''
)
$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot
if (-not $Img) { $Img = Join-Path $proj 'isle_map.png' }
$Img = [System.IO.Path]::GetFullPath($Img)
if (-not (Test-Path $Img)) { throw "no such file: $Img" }
if (-not $Out) { $Out = $Img + '.js' }
$Out = [System.IO.Path]::GetFullPath($Out)

$bytes = [System.IO.File]::ReadAllBytes($Img)
# sanity: the PNG signature, then IHDR - its width/height are what ISLE_ART and
# the pixel trace were calibrated against, so print them
$magic = [byte[]](0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
if ($bytes.Length -lt 24) { throw "$Img is too short to be a PNG" }
for ($i = 0; $i -lt 8; $i++) {
  if ($bytes[$i] -ne $magic[$i]) { throw "$([System.IO.Path]::GetFileName($Img)) is not a PNG (bad magic)" }
}
function ReadBE32([byte[]]$b, [int]$o) {
  return ([int64]$b[$o] -shl 24) -bor ([int64]$b[$o + 1] -shl 16) -bor ([int64]$b[$o + 2] -shl 8) -bor [int64]$b[$o + 3]
}
$w = ReadBE32 $bytes 16
$h = ReadBE32 $bytes 20

Write-Host "packing $([System.IO.Path]::GetFileName($Img)) ($($w)x$($h), $([Math]::Round($bytes.Length / 1MB, 2)) MB) ..."
$b64 = [Convert]::ToBase64String($bytes)
$text = @"
/* $([System.IO.Path]::GetFileName($Img)) as base64 - GENERATED, do not edit.
   Rebuild with:  powershell -NoProfile -File tools/img-to-b64.ps1
   Only read by the game when the page is opened from file:// and the picture
   itself cannot be loaded. Sets window.$Global.
   Picture: $($w)x$($h), $(($bytes | Measure-Object).Count) bytes. */
window.$Global = '$b64';
"@
[System.IO.File]::WriteAllText($Out, $text, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "wrote $Out ($([Math]::Round((Get-Item $Out).Length / 1MB, 2)) MB)"
