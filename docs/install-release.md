# croakcode 설치

설치 파일은 croak 게이트가 `/download/`에서 내준다. 로그인은 필요 없다. 관리자에게 게이트 주소(`https://…:8443`)만 받는다. 설치한 뒤에는 새 터미널을 열고 프로젝트 폴더에서 `croakcode`를 실행한다. `/login`을 입력해 로그인한다.

## 인증서 확인

게이트는 사내 CA가 발급한 인증서를 쓴다. 처음 설치할 때는 PC가 아직 이 CA를 모른다. 그래서 설치 스크립트는 처음 받은 CA를 믿고 저장한다. 화면에 그 지문을 보여 준다.

- 다음 설치와 업데이트부터는 저장한 CA로만 게이트를 확인한다. 게이트의 CA가 바뀌었으면 설치가 멈춘다.
- 첫 설치 순간에 같은 망에서 누군가 가짜 게이트를 내밀면 막을 수 없다. 이 위험을 줄이려면 관리자에게 CA 지문을 받아 화면의 지문과 비교한다.
- 지문을 미리 넣어 엄격하게 확인할 수도 있다. Linux, macOS, WSL은 `--ca-sha256 <지문>`, Windows는 `-CaSha256 <지문>`을 붙인다. 게이트의 CA를 바꾼 뒤에도 이 옵션으로 새 CA를 받는다.

## 내려받아 설치 (가장 쉬운 방법)

브라우저로 `https://게이트주소:8443/download/`를 연다. 처음 열 때 브라우저가 인증서 경고를 띄운다. 사내 CA라서 그렇다. "고급"을 누르고 계속 진행한다.

| 운영체제 | 할 일 |
|---|---|
| Windows (x64) | "Windows용 설치 파일"을 받아 더블클릭한다. "Windows의 PC 보호" 창이 뜨면 "추가 정보"를 누르고 "실행"을 누른다 |
| macOS | "macOS용 설치 파일"(zip)을 받아 푼다. `croakcode-setup.command`를 오른쪽 클릭하고 "열기"를 누른다. 처음 한 번만 이렇게 연다 |
| Linux, WSL | "Linux용 설치 파일"을 받아 그 폴더의 터미널에서 `bash croakcode-setup-linux.sh`를 실행한다 |

설치 파일에는 게이트 주소가 이미 들어 있다. 따로 넣을 값이 없다.

## 터미널로 설치

안내 페이지의 명령을 복사해 붙여 넣어도 된다. 명령에서 게이트 주소만 바꾸면 된다.

Linux, WSL, macOS:

```sh
curl -fsSLk --proto '=https' https://게이트주소:8443/download/install.sh | bash
```

Windows(PowerShell):

```powershell
curl.exe -fsSLk --proto =https https://게이트주소:8443/download/install.ps1 -o $env:TEMP\croak-install.ps1; powershell -NoProfile -ExecutionPolicy Bypass -File $env:TEMP\croak-install.ps1
```

- 설치 스크립트에도 게이트 주소가 들어 있어 `--gate`를 붙이지 않는다. 다른 게이트를 쓰려면 `--gate`(Windows는 `-Gate`)로 지정한다.
- 필요한 도구: Linux, WSL, macOS는 `curl`, `openssl`, `tar`다. macOS에는 이미 있다. Windows는 x64만 지원한다.
- macOS는 Intel과 Apple Silicon을 모두 지원한다. 실행 파일에 Apple 서명이 없다. 처음 실행할 때 보안 경고가 뜨면 시스템 설정의 개인정보 보호 및 보안에서 허용한다.
- `-ExecutionPolicy Bypass`는 이 설치 스크립트 한 번에만 적용된다.

## 설치한 뒤

- 로그인 정보는 `~/.config/croak/`에 둔다. 설치를 다시 해도 그대로 남는다.
- 기존 `~/.croakcode` 설정과 실행 명령은 이름에 시각을 붙여 보관한다.
- 업데이트는 `croakcode upgrade`로 한다. 자세한 내용은 `docs/update-release.md`에 있다.
- HWP 도구(rhwp)는 따로 설치한다.
- Windows 기본 콘솔에서는 화면을 그릴 수 없다. 그 콘솔에서 실행하면 Windows Terminal 새 창으로 다시 연다. 기본 콘솔에서 연 WSL도 같다. Windows Terminal이 없으면 설치 방법을 알린다.
- 이 PC에서 소스 설치본을 실행 파일로 바꿀 때는 대화 기록(`croakcode-local.db`)을 `croakcode.db`로 옮긴다.
