#!/usr/bin/env python3
"""TUI 통합 E2E: 두 세션을 실제 PTY 로 띄워 전송/수신/보류/뷰어/종료를 검증한다.

Linux 전용(pty). 외부 의존성 없음. 실패 시 0 이 아닌 코드로 종료한다.

사용:
    python3 next/e2e-tui.py            # dist 바이너리 자동 빌드
    python3 next/e2e-tui.py --bin PATH  # 이미 빌드된 바이너리 사용
"""
import os
import pty
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")

failures = []


def check(name, cond, detail=""):
    mark = "PASS" if cond else "FAIL"
    print(f"  [{mark}] {name}" + (f" — {detail}" if not cond and detail else ""))
    if not cond:
        failures.append(name)


def strip(data: str) -> str:
    return ANSI.sub("", data)


class Session:
    def __init__(self, bin_path, env, name):
        self.name = name
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.execvpe(bin_path, [bin_path, "session", "--name", name, "--tui"], env)
        self.buf = ""

    def read(self, secs=0.5):
        end = time.time() + secs
        chunk = ""
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.1)
            if r:
                try:
                    chunk += os.read(self.fd, 65536).decode("utf-8", "replace")
                except OSError:
                    break
        self.buf += chunk
        return chunk

    def send(self, text):
        os.write(self.fd, text.encode("utf-8"))

    def screen(self):
        return strip(self.buf)

    def wait_exit(self, secs=3.0):
        end = time.time() + secs
        while time.time() < end:
            wpid, status = os.waitpid(self.pid, os.WNOHANG)
            if wpid == self.pid:
                return os.waitstatus_to_exitcode(status)
            time.sleep(0.05)
        return None

    def kill(self):
        try:
            os.kill(self.pid, 9)
        except ProcessLookupError:
            pass


def main():
    if not sys.platform.startswith("linux"):
        print("이 테스트는 Linux(pty) 전용이다.")
        return 0

    bin_path = None
    if "--bin" in sys.argv:
        bin_path = sys.argv[sys.argv.index("--bin") + 1]
    if not bin_path:
        tmp = tempfile.mkdtemp(prefix="croak-e2e-")
        bin_path = os.path.join(tmp, "croakcode-next")
        print("빌드:", bin_path)
        code = subprocess.call(
            ["bun", "build", "--compile", os.path.join(ROOT, "next", "cli.ts"), "--outfile", bin_path],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if code != 0:
            print("빌드 실패")
            return 1

    base = tempfile.mkdtemp(prefix="croak-e2e-run-")
    env = {
        "PATH": "/usr/bin:/bin:/usr/local/bin",
        "HOME": os.path.join(base, "home"),
        "XDG_DATA_HOME": os.path.join(base, "data"),
        "XDG_CONFIG_HOME": os.path.join(base, "config"),
        "XDG_CACHE_HOME": os.path.join(base, "cache"),
        "XDG_RUNTIME_DIR": os.path.join(base, "run"),
        "TERM": "xterm-256color",
        "FORCE_COLOR": "1",
    }
    for k in ("HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"):
        os.makedirs(env[k], exist_ok=True)

    alpha = beta = None
    try:
        print("[1] 두 TUI 세션 시작")
        alpha = Session(bin_path, env, "alpha")
        time.sleep(0.5)
        alpha.read(0.2)
        beta = Session(bin_path, env, "beta")
        time.sleep(1.2)
        alpha.read(0.3)
        beta.read(0.3)

        check("alpha 상태줄 표시", "alpha" in alpha.screen(), alpha.screen()[-200:])
        screen_beta = beta.screen()
        check("beta 가 peer 2 로 인식", "2 peers" in screen_beta, screen_beta[-200:])
        check("색상 코드(배경) 적용", "\x1b[48;5;24m" in beta.buf)

        print("[2] alpha -> beta 전송")
        alpha.send("/send beta 한글 메시지 전체 뷰어 확인\r")
        time.sleep(0.6)
        alpha.read(0.3)
        beta.read(0.6)
        check("beta 수신(보류)", "한글 메시지 전체 뷰어 확인" in beta.screen(), beta.screen()[-300:])

        print("[3] beta /held 확인")
        beta.send("/held\r")
        time.sleep(0.4)
        beta.read(0.4)
        check("beta /held 목록", "한글 메시지 전체 뷰어 확인" in beta.screen())

        print("[3b] beta /held find")
        beta.send("/held find 뷰어\r")
        time.sleep(0.3)
        beta.read(0.3)
        check("beta /held find 검색", "한글 메시지 전체 뷰어 확인" in beta.screen())

        print("[4] beta /view 전체화면 뷰어")
        beta.send("/view\r")
        time.sleep(0.5)
        beta.read(0.4)
        vscreen = beta.screen()
        check("뷰어 헤더(보낸이)", "보낸이: alpha" in vscreen, vscreen[-300:])
        check("뷰어 본문", "한글 메시지 전체 뷰어 확인" in vscreen)
        check("뷰어 힌트", "닫기" in vscreen)
        beta.send("q")
        time.sleep(0.2)
        beta.read(0.2)

        print("[5] 정상 종료(/quit)")
        alpha.send("/quit\r")
        beta.send("/quit\r")
        code_a = alpha.wait_exit()
        code_b = beta.wait_exit()
        check("alpha exit 0", code_a == 0, f"code={code_a}")
        check("beta exit 0", code_b == 0, f"code={code_b}")
    finally:
        for s in (alpha, beta):
            if s:
                s.kill()
        shutil.rmtree(base, ignore_errors=True)

    print()
    if failures:
        print(f"실패 {len(failures)}건: {', '.join(failures)}")
        return 1
    print("모든 TUI E2E 통과")
    return 0


if __name__ == "__main__":
    sys.exit(main())
