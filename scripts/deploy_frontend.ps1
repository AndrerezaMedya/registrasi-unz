<##
Deploy frontend (gate + monitor) to Firebase Hosting.
Usage:
  powershell -ExecutionPolicy Bypass -File .\scripts\deploy_frontend.ps1 -Project registrasi-unz
Params:
  -Project : Firebase project id (default: taken from .firebaserc if present)
##>
param(
  [string]$Project
)

Write-Host "== Build/Prepare Frontend ==" -ForegroundColor Cyan
# We copy public/gate and public/monitor plus qrs + assets into dist/ for hosting.
$RepoRoot = Split-Path $PSScriptRoot -Parent
Set-Location $RepoRoot

$dist = Join-Path $RepoRoot 'dist'
if(!(Test-Path $dist)){ New-Item -ItemType Directory -Path $dist | Out-Null }

# Ensure subfolders
$targets = @('gate','monitor','qrs','assets')
foreach($t in $targets){
  $src = Join-Path $RepoRoot "public/$t"
  if(Test-Path $src){
    $dest = Join-Path $dist $t
    if(Test-Path $dest){ Remove-Item -Recurse -Force $dest }
    Copy-Item -Recurse -Force $src $dest
  }
}
# Also copy root public/index.html if exists (optional landing)
$rootIndex = Join-Path $RepoRoot 'public/index.html'
if(Test-Path $rootIndex){ Copy-Item $rootIndex (Join-Path $dist 'index.html') -Force }

Write-Host "Files prepared in dist/." -ForegroundColor Green

if(-not $Project){
  # Try parse .firebaserc
  $firebaserc = Join-Path $RepoRoot '.firebaserc'
  if(Test-Path $firebaserc){
    try { $json = Get-Content $firebaserc -Raw | ConvertFrom-Json; $Project = $json.projects.default } catch {}
  }
}
if(-not $Project){ Write-Warning 'Firebase project not specified and could not infer from .firebaserc. Use -Project <id>' }

Write-Host "== Firebase Deploy ==" -ForegroundColor Cyan
if($Project){
  firebase deploy --only hosting --project $Project
}else{
  firebase deploy --only hosting
}
