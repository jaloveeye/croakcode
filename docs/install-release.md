# croakcode 설치

관리자에게 게이트 주소와 CA 인증서의 SHA-256 지문을 받는다. 설치 스크립트의 SHA-256도 따로 받는다. 스크립트를 실행하기 전에 이 값을 확인한다.

## Linux, macOS, WSL

관리자가 알려 준 값으로 세 변수를 채운다. `SCRIPT_SHA256`은 설치 스크립트 파일의 해시다. `CA_SHA256`은 CA 인증서의 지문이다.

```sh
GATE='https://게이트주소:포트'
CA_SHA256='관리자가 알려 준 CA 지문'
SCRIPT_SHA256='관리자가 알려 준 스크립트 해시'
curl -fsSL --proto '=https' -k "$GATE/download/install.sh" -o /tmp/croak-install.sh && test "$(openssl dgst -sha256 /tmp/croak-install.sh | awk '{print tolower($NF)}')" = "$SCRIPT_SHA256" && bash /tmp/croak-install.sh --gate "$GATE" --ca-sha256 "$CA_SHA256"
```

스크립트는 CA 인증서의 지문을 확인한다. 그다음 인증서를 사용해 배포 목록과 묶음을 받는다. 묶음의 SHA-256을 검사한 뒤 설치한다. 기존 `~/.croakcode` 설정은 이름을 바꿔 보관한다.

## Windows

PowerShell에서 관리자에게 받은 세 값을 채운다. 스크립트 파일의 해시를 확인한 뒤 실행한다.

```powershell
$Gate = 'https://게이트주소:포트'
$CaSha256 = '관리자가 알려 준 CA 지문'
$ScriptSha256 = '관리자가 알려 준 스크립트 해시'
$Installer = Join-Path $env:TEMP 'croak-install.ps1'
curl.exe -fsSL --proto '=https' -k "$Gate/download/install.ps1" -o $Installer; if ($LASTEXITCODE -ne 0 -or (Get-FileHash $Installer -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ScriptSha256.ToLowerInvariant()) { throw '설치 스크립트 확인 실패' }; & $Installer -Gate $Gate -CaSha256 $CaSha256
```

Windows에서는 x64를 지원한다. 새 터미널을 열고 `croakcode`를 실행한다. `/login`으로 로그인한다. 로그인 정보는 기존 위치에 그대로 둔다.

이 PC에서 소스 설치본을 실행 파일로 바꾸기 전에는 기존 대화 기록을 옮겨야 한다. 이 작업은 첫 배포 단계에서 처리한다. HWP 도구는 따로 설치한다.
