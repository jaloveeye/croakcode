# Install a release from the croak gate.
#
# Trust in the gate's CA, in this order:
#   -CaSha256 given   the downloaded CA must have that fingerprint (strict; also how a new CA is adopted)
#   CA already saved  downloads are verified with it, and the gate's CA must still be the same
#   neither           first install: the CA is trusted as received and its fingerprint printed (like SSH)
# The first case without a fingerprint cannot detect a fake gate on the network at that moment.
param(
    [string]$Gate = '',
    [string]$CaSha256 = ''
)
$ErrorActionPreference = 'Stop'
# The gate puts its own address here when it publishes this script
# (croakagent publish-downloads.py), so a download needs no -Gate.
$DefaultGate = '__CROAK_GATE__'
if (-not $Gate -and $DefaultGate -like 'https://*') { $Gate = $DefaultGate }
if ($Gate -cnotmatch '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$') { throw 'Gate must be https://host[:port]' }
$expected = ($CaSha256 -replace '[: ]', '').ToLowerInvariant()
if ($expected -and $expected -cnotmatch '^[0-9a-f]{64}$') { throw 'CaSha256 must be a SHA-256 certificate fingerprint' }
$architecture = $env:PROCESSOR_ARCHITECTURE
if ($env:PROCESSOR_ARCHITEW6432) { $architecture = $env:PROCESSOR_ARCHITEW6432 }
if (-not [Environment]::Is64BitOperatingSystem -or $architecture -ne 'AMD64') { throw 'Only Windows x64 is supported' }
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { throw 'curl.exe is required' }
# curl.exe on Windows (schannel) asks for the certificate's revocation status. The
# gate's private CA publishes no revocation list, so the check cannot finish:
# --ssl-revoke-best-effort still checks where a list exists and verifies the
# certificate against the saved CA, but does not fail when there is none.
$work = Join-Path ([IO.Path]::GetTempPath()) ('croak-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    $ca = Join-Path $work 'ca.crt'
    function Get-CaFingerprint([string]$Path) {
        $pem = Get-Content -Raw -LiteralPath $Path
        if ($pem -notmatch '(?s)^\s*-----BEGIN CERTIFICATE-----\s*([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----\s*$') { throw 'Invalid CA certificate' }
        $der = [Convert]::FromBase64String(($Matches[1] -replace '\s', ''))
        $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList (,$der)
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($sha.ComputeHash($certificate.RawData))).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose(); $certificate.Dispose() }
    }
    $saved = Join-Path $env:USERPROFILE '.config\croak\ca\ca.crt'
    if (-not $expected -and (Test-Path -LiteralPath $saved -PathType Leaf)) {
        # Verified with the CA this PC already trusts; a different CA at the gate stops here.
        & curl.exe -fsSL --proto '=https' --tlsv1.2 --ssl-revoke-best-effort --cacert $saved "$Gate/download/ca.crt" -o $ca
        if ($LASTEXITCODE -ne 0) { throw 'The gate could not be verified with the CA saved on this PC; if the gate CA changed, pass -CaSha256' }
        if ((Get-CaFingerprint $ca) -cne (Get-CaFingerprint $saved)) { throw 'The gate CA differs from the one saved on this PC; pass -CaSha256 to adopt a new one' }
    } else {
        # Only this CA download skips TLS verification.
        & curl.exe -fsSL --proto '=https' --tlsv1.2 -k "$Gate/download/ca.crt" -o $ca
        if ($LASTEXITCODE -ne 0) { throw 'CA download failed' }
        $actual = Get-CaFingerprint $ca
        if ($expected) {
            if ($actual -cne $expected) { throw 'CA fingerprint does not match' }
        } else {
            Write-Host "First install: trusting the gate certificate as received. Fingerprint: $actual"
            Write-Host 'Compare it with the fingerprint from your administrator, if you have one. Later installs and updates trust only this certificate.'
        }
    }
    function Get-Download([string]$Name, [string]$Path) {
        & curl.exe -fsSL --proto '=https' --tlsv1.2 --ssl-revoke-best-effort --cacert $ca "$Gate/download/$Name" -o $Path
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
if exist "%USERPROFILE%\.local\share\croakcode\croakcode.pending.exe" (
  move /y "%USERPROFILE%\.local\share\croakcode\croakcode.pending.exe" "%USERPROFILE%\.local\share\croakcode\croakcode.exe" >nul
  if errorlevel 1 (
    echo Close all running croakcode processes and try again.
    exit /b 1
  )
)
rem A terminal can start in the Windows system folder; never use it as the project.
if /i "%CD%"=="%SystemRoot%\System32" cd /d "%USERPROFILE%"
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
    Write-Host "croakcode $version 설치를 마쳤습니다. Windows Terminal(시작 메뉴의 '터미널')을 새로 열고 croakcode를 실행한 뒤 /login을 입력하세요."
    Write-Host "Windows 기본 콘솔 창에서는 croakcode 화면이 뜨지 않습니다."
}
finally { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
