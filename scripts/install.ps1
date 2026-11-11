# Install a release after checking the administrator-provided CA fingerprint.
param(
    [Parameter(Mandatory = $true)][string]$Gate,
    [Parameter(Mandatory = $true)][string]$CaSha256
)
$ErrorActionPreference = 'Stop'
if ($Gate -cnotmatch '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$') { throw 'Gate must be https://host[:port]' }
$expected = ($CaSha256 -replace '[: ]', '').ToLowerInvariant()
if ($expected -cnotmatch '^[0-9a-f]{64}$') { throw 'CaSha256 must be a SHA-256 certificate fingerprint' }
$architecture = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) { $architecture = $env:PROCESSOR_ARCHITEW6432 }
if (-not [Environment]::Is64BitOperatingSystem -or $architecture -ne 'AMD64') { throw 'Only Windows x64 is supported' }
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { throw 'curl.exe is required' }
$work = Join-Path ([IO.Path]::GetTempPath()) ('croak-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    $ca = Join-Path $work 'ca.crt'
    # The fingerprint authenticates this first download before it is trusted.
    & curl.exe -fsSL --proto '=https' --tlsv1.2 -k "$Gate/download/ca.crt" -o $ca
    if ($LASTEXITCODE -ne 0) { throw 'CA download failed' }
    $pem = Get-Content -Raw -LiteralPath $ca
    if ($pem -notmatch '(?s)^\s*-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----\s*$') { throw 'Invalid CA certificate' }
    $der = [Convert]::FromBase64String(($Matches[1] -replace '\s', ''))
    $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList (,$der)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $actual = ([BitConverter]::ToString($sha.ComputeHash($certificate.RawData))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $certificate.Dispose() }
    if ($actual -cne $expected) { throw 'CA fingerprint does not match' }
    function Get-Download([string]$Name, [string]$Path) {
        & curl.exe -fsSL --proto '=https' --tlsv1.2 --cacert $ca "$Gate/download/$Name" -o $Path
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $Name" }
    }
    $manifestPath = Join-Path $work 'manifest.json'
    Get-Download 'manifest.json' $manifestPath
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $version = [string]$manifest.latest
    if ($version -cnotmatch '^\d+\.\d+\.\d+$') { throw 'Invalid release version' }
    $item = $manifest.files.'windows-x64'
    $name = "croakcode-$version-windows-x64.zip"
    if ($item.file -cne $name -or $item.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid archive in manifest' }
    $archive = Join-Path $work 'archive.zip'
    Get-Download $name $archive
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $item.sha256) { throw 'Archive SHA-256 does not match' }
    $unpack = Join-Path $work 'unpack'
    Expand-Archive -LiteralPath $archive -DestinationPath $unpack
    $binary = Join-Path $unpack 'bin\croakcode.exe'
    $configSource = Join-Path $unpack 'config'
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf) -or -not (Test-Path -LiteralPath $configSource -PathType Container)) { throw 'Archive is missing executable or config' }
    $base = Join-Path $HOME '.local\share\croakcode'
    $settings = Join-Path $HOME '.config\croak'
    $bin = Join-Path $HOME '.local\bin'
    $config = Join-Path $HOME '.croakcode'
    New-Item -ItemType Directory -Force -Path $base, (Join-Path $settings 'ca'), $bin | Out-Null
    $launcherPath = Join-Path $bin 'croakcode.cmd'
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $launcherBackup = $launcherPath + '.bak-' + $stamp
    $backup = $config + '.bak-' + $stamp
    if ((Test-Path -LiteralPath $launcherPath) -and (Test-Path -LiteralPath $launcherBackup)) { throw 'Launcher backup already exists' }
    if ((Test-Path -LiteralPath $config) -and (Test-Path -LiteralPath $backup)) { throw 'Configuration backup already exists' }
    if (Test-Path -LiteralPath $launcherPath) {
        Move-Item -LiteralPath $launcherPath -Destination $launcherBackup
    }
    if (Test-Path -LiteralPath $config) {
        Move-Item -LiteralPath $config -Destination $backup
        Write-Host "기존 설정을 $backup 에 보관했습니다."
    }
    Move-Item -LiteralPath $configSource -Destination $config
    Copy-Item -LiteralPath $binary -Destination (Join-Path $base 'croakcode.exe') -Force
    Copy-Item -LiteralPath $ca -Destination (Join-Path $settings 'ca\ca.crt') -Force
    [IO.File]::WriteAllText((Join-Path $settings 'gate-url'), $Gate + "`r`n", [Text.Encoding]::ASCII)
    $launcher = @'
@echo off
setlocal
set /p CROAK_AUTH_URL=<"%USERPROFILE%\.config\croak\gate-url"
set "LITELLM_BASE_URL=%CROAK_AUTH_URL%/v1"
set "NODE_EXTRA_CA_CERTS=%USERPROFILE%\.config\croak\ca\ca.crt"
set "CROAK_CA_FILE=%NODE_EXTRA_CA_CERTS%"
"%USERPROFILE%\.local\share\croakcode\croakcode.exe" %*
exit /b %errorlevel%
'@
    [IO.File]::WriteAllText($launcherPath, $launcher, [Text.Encoding]::ASCII)
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not $userPath) { $userPath = '' }
    if (($userPath -split ';' | Where-Object { $_.TrimEnd('\') -ieq $bin.TrimEnd('\') }).Count -eq 0) {
        [Environment]::SetEnvironmentVariable('Path', (($userPath.TrimEnd(';') + ';' + $bin).TrimStart(';')), 'User')
    }
    Write-Host "croakcode $version 설치를 마쳤습니다. 새 터미널에서 croakcode를 실행하고 /login을 입력하세요."
}
finally { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
