/**
 * Evergreen(상시) 공고 탐지.
 *
 * 왜 필요한가 — 실측으로 확인된 문제:
 *
 *   Databricks 보드 803건 중 게시일 365일 초과가 123건이었고, 그 123건 전부가
 *   "5일 내 수정"으로 나왔다. 회사가 하나의 requisition을 닫지 않고 계속
 *   재사용하는 상시 채용 공고다. `first_published`는 "현재 채용 시도가 시작된
 *   날"이 아니라 "이 requisition이 최초 생성된 날"이다.
 *
 * 이걸 걸러내지 않으면 stale 비율이 58%까지 올라가고, 리드 신호가 노이즈가 된다.
 * 신호는 희소해야 가치가 있다.
 *
 * `updated_at`으로 구분할 수 없다는 점도 실측했다. Greenhouse의 updated_at은
 * 보드 전체 일괄 갱신 타임스탬프로, 수백 건이 고유값 5~9개만 공유한다
 * (Stripe 540건 중 84%가 동일 날짜). 개별 공고의 관리 여부를 알 수 없다.
 */

/**
 * 상시 채용/인재풀 공고에 쓰이는 제목 패턴.
 * 이런 공고는 특정 자리를 채우려는 게 아니므로 외주 발주 신호가 아니다.
 */
const EVERGREEN_TITLE_PATTERNS: RegExp[] = [
  /general\s+(application|interest)/i,
  /don'?t\s+see\s+(the\s+)?(perfect\s+)?(fit|role)/i,
  /talent\s+(community|pool|network|pipeline)/i,
  /expression\s+of\s+interest/i,
  /future\s+opportunit/i,
  /open\s+application/i,
  /speculative\s+application/i,
  /join\s+our\s+talent/i,
  /keep\s+in\s+touch/i,
  /other\s+(roles?|positions?)/i,
  /apply\s+here\s+if/i,
  // 인턴/신입 상시 모집 풀
  /(university|campus|new\s?grad)\s+(hire|hiring|talent)/i,
  // 지역/직무 미지정 광범위 공고
  /^\s*(engineering|sales|marketing|design)\s*$/i,
];

/**
 * 이 일수를 넘는 "게시일"은 신뢰하지 않는다.
 *
 * 근거: 정상적인 채용 시도가 1년을 넘게 단일 requisition으로 유지되는 경우는
 * 드물다. 그보다 오래된 값은 requisition 재사용을 의미할 가능성이 높다.
 * 이 임계를 넘으면 evergreen으로 분류하고 staleness 신호에서 제외한다.
 */
export const EVERGREEN_AGE_THRESHOLD_DAYS = 365;

/**
 * `first_published`를 신호로 쓸 때의 상한.
 *
 * 60일과 300일의 차이는 리드 품질 차이로 이어지지 않는다. 둘 다 "오래됨"이다.
 * 상한을 두지 않으면 evergreen이 상위를 독점해 실제 핫리드를 가린다.
 */
export const REPORTED_AGE_CAP_DAYS = 180;

/**
 * 아카이브가 증명하는 경과일을 "하나의 채용 시도"로 읽을 수 있는 상한.
 *
 * ── 왜 필요한가 ──
 *
 * EVERGREEN_AGE_THRESHOLD_DAYS(365일)는 **ATS 보고 게시일에만** 적용된다. 그런데
 * 나이의 1차 근거는 아카이브이고 그쪽에는 상한이 없었다. 그래서 evergreen 필터가
 * 점수가 가장 높은 지점에서 정확히 우회됐다.
 *
 * 실측: linear 의 `Senior / Staff Product Engineer` 가 1,527일(4.2년)로 상위
 * 5위에 올라 공개 페이지 첫 화면에 실렸다. 4년 열린 공고는 "못 뽑고 있다"가
 * 아니라 채용 공고가 아니다. 회의적인 방문자가 그 링크 하나를 눌러보면 이 제품의
 * 정직성 주장이 무너진다.
 *
 * ── 무엇을 하는가 ──
 *
 * 리드를 버리지 않는다. **경과일이라는 근거의 자격만 내린다.** URL 이 1,527일 전에
 * 존재했다는 사실은 여전히 참이지만, 그것을 "연속된 하나의 채용 시도"로 주장할 수
 * 없다. 그래서 Hot 을 주지 않고 화면에 재사용 의심을 명시한다.
 *
 * 730일은 판단이다. 단일 requisition 으로 2년을 유지하는 정상 채용은 드물고,
 * 그보다 오래된 URL 존속은 재사용이나 사실상 상시 공고를 뜻할 가능성이 높다.
 */
export const ARCHIVE_AGE_SUSPECT_DAYS = 730;

/**
 * 이 경과일을 "못 뽑고 있다"의 증거로 쓸 수 있는가.
 *
 * 표시와 등급 양쪽에서 같은 기준을 써야 한다 — 화면은 의심을 표시하는데 등급은
 * Hot 을 주면 사용자가 어느 쪽을 믿어야 할지 알 수 없다.
 */
export function isAgeSuspect(ageDays: number | null | undefined): boolean {
  return typeof ageDays === 'number' && ageDays > ARCHIVE_AGE_SUSPECT_DAYS;
}

export type EvergreenReason = 'title_pattern' | 'age_threshold' | 'demo_board';

export interface EvergreenVerdict {
  isEvergreen: boolean;
  reasons: EvergreenReason[];
  detail: string | null;
}

/**
 * 데모/샘플 보드. 가짜 데이터가 들어 있어 리드로 쓸 수 없다.
 * 실측: lever:leverdemo에서 4,681일(12.8년) 경과 공고가 다수 발견됨.
 */
const DEMO_BOARD_SLUGS = new Set(['leverdemo', 'demo', 'test', 'sandbox', 'example']);

export function isDemoBoard(companySlug: string): boolean {
  return DEMO_BOARD_SLUGS.has(companySlug.toLowerCase());
}

export function detectEvergreen(input: {
  title: string;
  reportedAgeDays: number | null;
  companySlug: string;
}): EvergreenVerdict {
  const reasons: EvergreenReason[] = [];
  const details: string[] = [];

  if (isDemoBoard(input.companySlug)) {
    reasons.push('demo_board');
    details.push('데모 보드');
  }

  const matched = EVERGREEN_TITLE_PATTERNS.find((p) => p.test(input.title));
  if (matched) {
    reasons.push('title_pattern');
    details.push('상시/인재풀 공고 제목');
  }

  if (
    input.reportedAgeDays !== null &&
    input.reportedAgeDays > EVERGREEN_AGE_THRESHOLD_DAYS
  ) {
    reasons.push('age_threshold');
    details.push(
      `게시일 ${input.reportedAgeDays}일 — requisition 재사용 추정`,
    );
  }

  return {
    isEvergreen: reasons.length > 0,
    reasons,
    detail: details.length > 0 ? details.join(', ') : null,
  };
}

/**
 * 신호로 쓸 수 있게 보정한 게시 경과일.
 * evergreen이면 null(신호 사용 불가), 아니면 상한을 적용한 값.
 */
export function usableReportedAge(
  reportedAgeDays: number | null,
  verdict: EvergreenVerdict,
): number | null {
  if (reportedAgeDays === null || verdict.isEvergreen) return null;
  return Math.min(reportedAgeDays, REPORTED_AGE_CAP_DAYS);
}
