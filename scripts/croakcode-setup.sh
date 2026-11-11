#!/usr/bin/env bash
# croakcode setup for macOS and Linux.
#   macOS: the gate offers it as croakcode-setup-macos.zip; open the zip and
#          double-click croakcode-setup.command (the first time: right-click, Open).
#   Linux: the gate offers it as croakcode-setup-linux.sh; run: bash croakcode-setup-linux.sh
# The croak gate puts its address here when it publishes this file.
gate='__CROAK_GATE__'
finish() {
  # A double-clicked window closes when the script ends; let the user read it first.
  if [ -t 0 ]; then read -r -p "Enter를 누르면 창을 닫습니다. " _; fi
  exit "$1"
}
case "$gate" in
  https://*) ;;
  *) echo "이 파일은 croak 게이트의 내려받기 페이지에서 받아야 합니다."; finish 1 ;;
esac
echo "croakcode를 설치합니다. 게이트: $gate"
curl -fsSLk --proto '=https' "$gate/download/install.sh" | bash -s -- --gate "$gate"
status=${PIPESTATUS[1]}
[ "${PIPESTATUS[0]}" = 0 ] || { echo "설치 스크립트를 받지 못했습니다."; finish 1; }
if [ "$status" = 0 ]; then echo "설치를 마쳤습니다. 새 터미널을 열어 croakcode를 실행하고 /login을 입력하세요."; fi
finish "$status"
