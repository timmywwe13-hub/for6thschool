# =====================================================================
# Builds vendor/GLTFLoader.js - three.js' GLTFLoader addon turned into a
# CLASSIC script that binds THREE.GLTFLoader.
#
# Why: index.html has to run straight off the disk (file://), where the
# browser refuses both ES modules and XHR/fetch for local files. The npm
# addon only ships an ES module, so this script pulls the module, swaps its
# `import ... from 'three'` for a destructuring of the global THREE, inlines
# the single helper it imports from BufferGeometryUtils and exposes the class
# on THREE.
#
# Usage:  powershell -NoProfile -File tools/build-gltfloader.ps1
#         (optional) -Version 0.160.0 -OutFile vendor/GLTFLoader.js
# =====================================================================
param(
  [string]$Version = '0.160.0',
  [string]$OutFile = ''
)
$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $PSScriptRoot
if (-not $OutFile) { $OutFile = Join-Path $proj 'vendor\GLTFLoader.js' }
$OutFile = [System.IO.Path]::GetFullPath($OutFile)

$tmp = Join-Path $env:TEMP 'gltfloader-build'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$esmPath = Join-Path $tmp 'GLTFLoader.esm.js'
$utilPath = Join-Path $tmp 'BufferGeometryUtils.esm.js'
$cdn = "https://cdn.jsdelivr.net/npm/three@$Version/examples/jsm"

Write-Host "downloading three@$Version addons ..."
Invoke-WebRequest "$cdn/loaders/GLTFLoader.js" -OutFile $esmPath -UseBasicParsing
Invoke-WebRequest "$cdn/utils/BufferGeometryUtils.js" -OutFile $utilPath -UseBasicParsing

$src = [System.IO.File]::ReadAllText($esmPath)
$util = [System.IO.File]::ReadAllText($utilPath)

# --- 1. turn the "import { ... } from 'three'" header into a destructuring ---
$i0 = $src.IndexOf('import {')
$i1 = $src.IndexOf("} from 'three';")
if ($i0 -lt 0 -or $i1 -lt 0) { throw 'GLTFLoader header not recognised - update this script' }
$names = $src.Substring($i0 + 'import {'.Length, $i1 - ($i0 + 'import {'.Length)) -split "[,\r\n\t ]+" |
  Where-Object { $_ -ne '' }
if ($names -notcontains 'TrianglesDrawMode') { $names += 'TrianglesDrawMode' }
$body = $src.Substring($i1 + "} from 'three';".Length)
$body = $body.Replace("import { toTrianglesDrawMode } from '../utils/BufferGeometryUtils.js';", '')
$body = $body.Replace('export { GLTFLoader };', "THREE.GLTFLoader = GLTFLoader;`n")
if ($body -match '(?m)^\s*(import|export)\s') { throw 'unconverted import/export left in the module body' }

# --- 2. lift the one helper the loader imports out of BufferGeometryUtils ---
$f0 = $util.IndexOf('function toTrianglesDrawMode(')
if ($f0 -lt 0) { throw 'toTrianglesDrawMode() not found in BufferGeometryUtils' }
$f1 = $util.IndexOf("`n}", $f0)
if ($f1 -lt 0) { throw 'could not find the end of toTrianglesDrawMode()' }
$helper = $util.Substring($f0, $f1 - $f0 + 2)

# --- 3. wrap it all up as a classic script bound to the global THREE -------
$decl = @()
for ($i = 0; $i -lt $names.Count; $i += 8) {
  $end = [Math]::Min($i + 7, $names.Count - 1)
  $decl += '  ' + (($names[$i..$end]) -join ', ')
}
$header = @"
/* =====================================================================
   three.js GLTFLoader r$Version as a CLASSIC script (three.js is MIT
   licensed, (c) 2010-2024 three.js authors - https://threejs.org).
   Exposes THREE.GLTFLoader so the game can load the player's glTF/GLB
   character from a page opened straight off the disk, where ES modules
   and local XHR are both blocked.

   GENERATED FILE - do not edit by hand. Rebuild with:
     powershell -NoProfile -File tools/build-gltfloader.ps1 -Version $Version
   Sources:
     $cdn/loaders/GLTFLoader.js
     $cdn/utils/BufferGeometryUtils.js  (only toTrianglesDrawMode)
   ===================================================================== */
(function () {
'use strict';
if (typeof THREE === 'undefined') {
  console.error('GLTFLoader (classic build): three.js must be loaded first');
  return;
}
/* the addon imports these names from the 'three' module */
const {
$($decl -join ",`n")
} = THREE;

$(($helper -replace "`n", "`n"))

"@
$footer = @"
})();
"@
$out = $header + $body + $footer
Write-Host "writing $OutFile ($([Math]::Round($out.Length / 1024)) KB)"
$dir = Split-Path -Parent $OutFile
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
[System.IO.File]::WriteAllText($OutFile, $out, (New-Object System.Text.UTF8Encoding($false)))
Write-Host 'done.'
