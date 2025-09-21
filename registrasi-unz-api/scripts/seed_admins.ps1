<#
seed_admins.ps1
Generates PBKDF2 hashes and upserts 9 admin accounts (8 staff + 1 super) into D1.
Usage:
  powershell -ExecutionPolicy Bypass -File .\scripts\seed_admins.ps1
Adjust $Accounts list if needed.
#>
param(
  [string]$DbName = 'registrasi_unz',
  [switch]$ShowSqlOnly
)

$Accounts = @(
  [PSCustomObject]@{ Id='u1'; Username='regisastra@dio.com';      Name='Regis Astra Dio';      Password='jawa02092004';    Role='staff' },
  [PSCustomObject]@{ Id='u2'; Username='regisastra@bara.com';     Name='Regis Astra Bara';     Password='jawa13112004';    Role='staff' },
  [PSCustomObject]@{ Id='u3'; Username='regisastra@hafizh.com';   Name='Regis Astra Hafizh';   Password='betawi09112005';   Role='staff' },
  [PSCustomObject]@{ Id='u4'; Username='regisastri@aspiratu.com'; Name='Regis Astri Aspiratu'; Password='batakkaro31072004';Role='staff' },
  [PSCustomObject]@{ Id='u5'; Username='regisastri@raudah.com';   Name='Regis Astri Raudah';   Password='sunda02122005';    Role='staff' },
  [PSCustomObject]@{ Id='u6'; Username='regisastri@nadia.com';    Name='Regis Astri Nadia';    Password='payobada15112003'; Role='staff' },
  [PSCustomObject]@{ Id='u7'; Username='regisastri@haura.com';    Name='Regis Astri Haura';    Password='sunda14042006';    Role='staff' },
  [PSCustomObject]@{ Id='u8'; Username='regis@asrama.com';        Name='Regis Asrama';         Password='salmanitb';        Role='staff' },
  [PSCustomObject]@{ Id='admin1'; Username='regis@admin.com';     Name='Super Admin';          Password='admin';            Role='super' }
)

function New-Pbkdf2Hash($Plain) {
  $Salt = New-Object byte[] 16
  ([System.Security.Cryptography.RNGCryptoServiceProvider]::Create()).GetBytes($Salt)
  $pbk  = New-Object System.Security.Cryptography.Rfc2898DeriveBytes($Plain, $Salt, 100000, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
  $dk   = $pbk.GetBytes(32)
  'pbkdf2$' + [Convert]::ToBase64String($Salt) + '$' + [Convert]::ToBase64String($dk)
}

$SqlLines = @()
foreach($a in $Accounts){
  $hash = New-Pbkdf2Hash $a.Password
  # Escape single quotes inside name (if any)
  $safeName = $a.Name -replace "'", "''"
  $SqlLines += "INSERT INTO admins(id,username,password_hash,name,role) VALUES ('$($a.Id)','$($a.Username)','$hash','$safeName','$($a.Role)') ON CONFLICT(username) DO UPDATE SET password_hash='$hash', name='$safeName', role='$($a.Role)';"
}

$OutFile = Join-Path $PSScriptRoot 'seed_admins.sql'
$SqlLines | Set-Content -Path $OutFile -Encoding UTF8

Write-Host "Generated SQL file: $OutFile" -ForegroundColor Cyan
if($ShowSqlOnly){
  Get-Content $OutFile
  exit 0
}

Write-Host "Executing against remote D1 ($DbName)..." -ForegroundColor Yellow
& wrangler d1 execute $DbName --remote --file $OutFile

Write-Host "Verify:" -ForegroundColor Cyan
& wrangler d1 execute $DbName --remote --command "SELECT id,username,role FROM admins WHERE username IN ('regisastra@dio.com','regisastra@bara.com','regisastra@hafizh.com','regisastri@aspiratu.com','regisastri@raudah.com','regisastri@nadia.com','regisastri@haura.com','regis@asrama.com','regis@admin.com');"
