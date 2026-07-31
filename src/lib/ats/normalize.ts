/**
 * ATS별 원본 값을 공통 형태로 수렴시키는 순수 함수 모음.
 * 커넥터는 여기에만 의존하고, 여기는 아무것에도 의존하지 않는다.
 */

import type { WorkplaceType } from './types.js';

/* ------------------------------------------------------------------ *
 * 날짜
 * ------------------------------------------------------------------ */

/**
 * ATS는 ISO 문자열, epoch ms, epoch s, null을 섞어서 준다.
 * 파싱 불가하거나 명백히 비현실적인 값(1990년 이전 / 미래 2일 초과)은 null 처리.
 * 잘못된 날짜는 staleness를 오염시키므로 조용히 통과시키면 안 된다.
 */
export function parseAtsDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;

  let date: Date | null = null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    // 10자리는 초, 13자리는 밀리초
    date = new Date(value < 1e11 ? value * 1000 : value);
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    // 숫자만으로 된 문자열도 epoch일 수 있다
    if (/^\d{10}$/.test(trimmed)) {
      date = new Date(Number(trimmed) * 1000);
    } else if (/^\d{13}$/.test(trimmed)) {
      date = new Date(Number(trimmed));
    } else {
      date = new Date(trimmed);
    }
  }

  if (!date || Number.isNaN(date.getTime())) return null;

  const year = date.getUTCFullYear();
  const twoDaysAhead = Date.now() + 2 * 86_400_000;
  if (year < 1990 || date.getTime() > twoDaysAhead) return null;

  return date;
}

/* ------------------------------------------------------------------ *
 * 제목 지문 (재게시 탐지 키)
 * ------------------------------------------------------------------ */

/**
 * 요구사항 번호·괄호 주석을 제거해 "같은 자리"를 식별하는 지문을 만든다.
 *
 * 중요: 직급어(senior/staff/junior)는 **제거하지 않는다**. 서로 다른 채용
 * 자리이기 때문이다. 제거 대상은 순수 노이즈로 한정한다.
 *
 *   "Aerostructures Design Engineer II (R4953)" -> "aerostructures design engineer ii"
 *   "Backend Engineer - Seoul [Req 12345]"      -> "backend engineer seoul"
 */
export function titleFingerprint(title: string): string {
  return title
    .toLowerCase()
    // 괄호/대괄호/중괄호 안의 내용 제거 (요구사항 번호, 지역 주석 등)
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    // 독립적으로 떠 있는 요구사항 번호 패턴: R4953, REQ-123, #1234, JR-99
    .replace(/\b(?:r|req|jr|job|id)[-_ ]?\d{2,}\b/g, ' ')
    .replace(/#\s*\d+/g, ' ')
    // 잔여 구두점 제거
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/* ------------------------------------------------------------------ *
 * 근무 형태 / 위치
 * ------------------------------------------------------------------ */

const REMOTE_RE = /\b(remote|anywhere|distributed|work\s*from\s*home|wfh|재택)\b/i;
const HYBRID_RE = /\b(hybrid|flexible\s*location|부분\s*재택)\b/i;
const ONSITE_RE = /\b(on-?site|in-?office|in-?person|상근)\b/i;

/**
 * 명시적 필드(있으면 신뢰) → 위치 문자열 휴리스틱 순으로 판정.
 * `explicit`은 ATS가 준 workplaceType/isRemote 계열 값.
 */
export function resolveWorkplaceType(
  explicit: string | boolean | null | undefined,
  locationHint?: string | null,
): WorkplaceType {
  if (typeof explicit === 'boolean') {
    if (explicit) return 'remote';
    // false는 "원격 아님"만 의미하므로 hybrid/onsite는 힌트로 다시 판단
  } else if (typeof explicit === 'string' && explicit.trim()) {
    const v = explicit.toLowerCase();
    if (v.includes('remote')) return 'remote';
    if (v.includes('hybrid')) return 'hybrid';
    if (v.includes('onsite') || v.includes('on-site') || v.includes('office')) {
      return 'onsite';
    }
  }

  const hint = locationHint ?? '';
  if (HYBRID_RE.test(hint)) return 'hybrid';
  if (REMOTE_RE.test(hint)) return 'remote';
  if (ONSITE_RE.test(hint)) return 'onsite';
  return explicit === false ? 'onsite' : 'unknown';
}

/**
 * "San Francisco, CA; Remote - US | New York" 같은 복합 문자열을 분해한다.
 * 구분자는 세미콜론/파이프/슬래시/"or"만 사용한다. 콤마는 "San Francisco, CA"
 * 처럼 도시-주 구분에 쓰이므로 분리 기준으로 쓰면 안 된다.
 */
export function parseLocations(...values: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const part of value.split(/\s*(?:[;|/]|\bor\b)\s*/i)) {
      const cleaned = part.trim().replace(/\s+/g, ' ');
      if (cleaned) out.add(cleaned);
    }
  }
  return [...out];
}

/* ------------------------------------------------------------------ *
 * 텍스트
 * ------------------------------------------------------------------ */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#x27': "'",
  '#x2F': '/',
};

/** Greenhouse의 `content`는 HTML이 엔티티 인코딩된 상태로 온다. */
export function decodeHtmlEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    const known = NAMED_ENTITIES[entity] ?? NAMED_ENTITIES[entity.toLowerCase()];
    if (known !== undefined) return known;
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

/**
 * HTML 본문을 기술스택 추출용 평문으로 변환.
 * 정규식 기반이지만 목적이 "키워드 매칭용 텍스트"이므로 충분하다.
 * 이 결과를 사용자에게 HTML로 렌더링하지 않는다는 전제.
 */
export function htmlToPlainText(html: string): string {
  return decodeHtmlEntities(html)
    // script/style 블록은 내용까지 제거
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    // 블록 요소는 줄바꿈으로, 나머지 태그는 공백으로
    .replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|tr|table|section)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** null·빈문자·공백만 있는 값을 일관되게 null로 만든다. */
export function nullifyBlank(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
