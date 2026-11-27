import { homedir } from "node:os"
import { join } from "node:path"

/** 모든 croakcode-next 데이터(세션 DB, 피어 레지스트리, 설정)의 기본 디렉터리. */
export function dataDir(): string {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "croakcode-next")
}

/** 기존 croakcode(upstream)가 쓰던 세션 DB. next/는 읽기 전용으로 호환한다. */
export function legacyDbFiles(): string[] {
  const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  const dir = join(base, "croakcode")
  // 설치본은 croakcode.db, 소스 실행은 croakcode-local.db를 쓴다.
  return [join(dir, "croakcode.db"), join(dir, "croakcode-local.db")]
}

/** 세션 간 메시징 소켓을 두는 디렉터리. 사용자 전용(0700)이어야 한다. */
export function socketDir(): string {
  const runtime = process.env.XDG_RUNTIME_DIR
  if (runtime) return join(runtime, "croakcode-next")
  return join("/tmp", `croak-next-${process.getuid?.() ?? "user"}`)
}

/** 활성 세션 등록 정보(JSON)를 두는 디렉터리. */
export function peersDir(): string {
  return join(dataDir(), "peers")
}

/** 설정 파일. 없으면 기본값을 쓴다. */
export function configFile(): string {
  return join(dataDir(), "config.json")
}

/** 교차 세션 수신 규칙의 종류. */
export type Inbound = "accept" | "hold" | "refuse"

export function isInbound(value: unknown): value is Inbound {
  return value === "accept" || value === "hold" || value === "refuse"
}
