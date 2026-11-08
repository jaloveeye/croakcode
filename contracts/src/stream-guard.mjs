/**
 * 스트림 타임아웃 2단계 + compaction idle guard 계약. Spec §4.9.
 * 검증된 사실: upstream 은 헤더 수신 전 타임아웃만 있고, 본문 idle guard 는 없다.
 */
export const STREAM_IDLE_ERROR_CODE = "STREAM_IDLE_TIMEOUT";

export const STREAM_TIMEOUT_PHASES = Object.freeze(["head", "body_idle"]);

export const STREAM_GUARD_DEFAULTS = Object.freeze({
  stream: Object.freeze({ headTimeoutMs: 60_000, bodyIdleTimeoutMs: 60_000 }),
  compaction: Object.freeze({ headTimeoutMs: 120_000, bodyIdleTimeoutMs: 120_000, alwaysOn: true }),
});

/**
 * compaction 경로는 기본으로 guard 가 켜져 있어야 한다(관측된 무한대기 재발 방지).
 * 0/undefined 를 명시하면 일반 스트림은 끌 수 있으나 compaction 은 항상 켠다.
 */
export function resolveIdleTimeout(kind, config) {
  const defaults = STREAM_GUARD_DEFAULTS[kind];
  if (!defaults) throw new Error(`unknown stream kind: ${kind}`);
  const idle = config?.bodyIdleTimeoutMs;
  if (kind === "compaction") {
    return typeof idle === "number" && idle > 0 ? idle : defaults.bodyIdleTimeoutMs;
  }
  if (idle === 0) return 0; // 명시적 비활성
  return typeof idle === "number" && idle > 0 ? idle : defaults.bodyIdleTimeoutMs;
}

/** compaction 중 idle 타임아웃은 재시도 금지(세션을 idle 로 되돌리고 중단). */
export function shouldRetryAfterIdle(kind) {
  return kind !== "compaction";
}
