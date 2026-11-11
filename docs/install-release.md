# croakcode 설치

설치 파일은 croak 게이트가 `/download/`에서 내준다. 로그인은 필요 없다. 관리자에게 게이트 주소(`https://…:8443`)만 받는다.

## 인증서 확인

게이트는 사내 CA가 발급한 인증서를 쓴다. 처음 설치할 때는 PC가 아직 이 CA를 모른다. 그래서 설치 스크립트는 처음 받은 CA를 믿고 저장한다. 화면에 그 지문을 보여 준다.

- 다음 설치와 업데이트부터는 저장한 CA로만 게이트를 확인한다. 게이트의 CA가 바뀌었으면 설치가 멈춘다.
- 첫 설치 순간에 같은 망에서 누군가 가짜 게이트를 내밀면 막을 수 없다. 이 위험을 줄이려면 관리자에게 CA 지문을 받아 화면의 지문과 비교한다.
- 지문을 미리 넣어 엄격하게 확인할 수도 있다. Linux, macOS, WSL은 `--ca-sha256 <지문>`, Windows는 `-CaSha256 <지문>`을 붙인다. 게이트의 CA를 바꾼 뒤에도 이 옵션으로 새 CA를 받는다.

## Linux, WSL

터미널에서 실행한다. `GATE`에는 관리자가 알려 준 주소를 넣는다.

```sh
GATE='https://게이트주소:8443'
curl -fsSLk --proto '=https' "$GATE/download/install.sh" | bash -s -- --gate "$GATE"
```

`curl`, `openssl`, `tar`가 있어야 한다. 설치가 끝나면 새 터미널을 연다. 프로젝트 폴더에서 `croakcode`를 실행하고 `/login`을 입력한다.

## macOS

터미널 앱에서 Linux와 같은 명령을 실행한다. macOS에는 `curl`, `openssl`, `tar`가 이미 있다.

```sh
GATE='https://게이트주소:8443'
curl -fsSLk --proto '=https' "$GATE/download/install.sh" | bash -s -- --gate "$GATE"
```

Intel과 Apple Silicon을 모두 지원한다. 스크립트가 CPU에 맞는 묶음을 고른다. 실행 파일에는 Apple 서명이 없다. 스크립트가 받은 파일의 격리 표시를 지운다. 그래도 처음 실행할 때 보안 경고가 뜨면 시스템 설정의 개인정보 보호 및 보안에서 허용한다. PATH 설정은 `~/.zprofile`에 더한다. 새 터미널을 열어 `croakcode`를 실행하고 `/login`을 입력한다.

## Windows

PowerShell에서 실행한다. x64만 지원한다.

```powershell
$Gate = 'https://게이트주소:8443'
$Installer = Join-Path $env:TEMP 'croak-install.ps1'
curl.exe -fsSLk --proto '=https' "$Gate/download/install.ps1" -o $Installer
powershell -NoProfile -ExecutionPolicy Bypass -File $Installer -Gate $Gate
```

`-ExecutionPolicy Bypass`는 이 설치 스크립트 한 번에만 적용된다. 설치가 끝나면 새 터미널을 연다. 프로젝트 폴더에서 `croakcode`를 실행하고 `/login`을 입력한다.

## 설치한 뒤

- 로그인 정보는 `~/.config/croak/`에 둔다. 설치를 다시 해도 그대로 남는다.
- 기존 `~/.croakcode` 설정과 실행 명령은 이름에 시각을 붙여 보관한다.
- 업데이트는 `croakcode upgrade`로 한다. 자세한 내용은 `docs/update-release.md`에 있다.
- HWP 도구(rhwp)는 따로 설치한다.
- 이 PC에서 소스 설치본을 실행 파일로 바꿀 때는 대화 기록(`croakcode-local.db`)을 `croakcode.db`로 옮긴다.
