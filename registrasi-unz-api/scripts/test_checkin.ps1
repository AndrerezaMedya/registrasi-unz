<#
Script: test_checkin.ps1
Purpose: End‑to‑end check-in flow test (login -> pick a code -> validate -> mark-used -> revalidate -> stats)
Usage:
  1. Adjust $Username / $Password below.
  2. (Optional) Set $SpecificCode if you want to force a certain code.
  3. Run:  powershell -ExecutionPolicy Bypass -File .\scripts\test_checkin.ps1
#>

param(
  [string]$ApiBase = 'https://registrasi-unz-api.formsurveyhth.workers.dev',
  [string]$Username = 'gate1',
  [string]$Password = 'Gate1Baru!2025',
  [string]$SpecificCode = ''
)

function Write-Section($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }
function Fail($m) { Write-Host "ERROR: $m" -ForegroundColor Red; exit 1 }

$origin = 'https://registrasi-unz.web.app'

Write-Section 'LOGIN'
$loginBody = @{ username = $Username; password = $Password } | ConvertTo-Json
try {
  $loginResp = Invoke-RestMethod -Uri "$ApiBase/login" -Method POST -ContentType 'application/json' -Headers @{ Origin = $origin } -Body $loginBody
}
catch { Fail "Login request failed: $($_.Exception.Message)" }
if (-not $loginResp.ok) { Fail "Login failed: $($loginResp.code)" }
$token = $loginResp.token
Write-Host "Got token (truncated): $($token.Substring(0,30))..." -ForegroundColor Green

# Helper for authorized POST JSON
function PostJson($path, $obj) {
  $json = $obj | ConvertTo-Json -Depth 5
  return Invoke-RestMethod -Uri "$ApiBase$path" -Method POST -ContentType 'application/json' -Headers @{ Authorization = "Bearer $token"; Origin = $origin } -Body $json
}

Write-Section 'PICK CODE'
if ($SpecificCode) {
  $code = $SpecificCode
  Write-Host "Using provided code: $code"
}
else {
  # Try to fetch one unused code via a raw SQL (needs API key path not available => fallback: sample from local list?)
  # Because we don't expose a public listing endpoint, we rely on manual input if not provided.
  Write-Host 'No SpecificCode given. Please enter a code to test:' -ForegroundColor Yellow
  $code = Read-Host 'Code'
}
if ([string]::IsNullOrWhiteSpace($code)) { Fail 'No code provided' }

Write-Section 'VALIDATE (before mark)'
$validate1 = PostJson '/validate' @{ code = $code }
$validate1 | ConvertTo-Json -Depth 5 | Write-Host
if (-not $validate1.ok) { Write-Host 'Stopping (code not found or already used).' -ForegroundColor Yellow; exit 0 }

if ($validate1.used -eq $true) {
  Write-Host 'Code already used. Test ends here.' -ForegroundColor Yellow; exit 0
}

Write-Section 'MARK USED'
$mark = PostJson '/mark-used' @{ code = $code; admin_id = $Username }
$mark | ConvertTo-Json -Depth 5 | Write-Host
if (-not $mark.ok) { Fail "Mark-used failed: $($mark.code)" }

Start-Sleep -Milliseconds 500
Write-Section 'REVALIDATE (after mark)'
$validate2 = PostJson '/validate' @{ code = $code }
$validate2 | ConvertTo-Json -Depth 5 | Write-Host

Write-Section 'STATS'
$stats = Invoke-RestMethod -Uri "$ApiBase/stats?window=6" -Headers @{ Authorization = "Bearer $token"; Origin = $origin }
$stats | ConvertTo-Json -Depth 5 | Write-Host

Write-Section 'SUMMARY'
Write-Host "Code: $code" -ForegroundColor Green
Write-Host "WasUsedBefore: $($validate1.used)" -ForegroundColor Green
Write-Host "MarkResult: $($mark.result)" -ForegroundColor Green
Write-Host "UsedNow: $($validate2.used) at $($validate2.used_at)" -ForegroundColor Green
Write-Host 'Done.' -ForegroundColor Green
