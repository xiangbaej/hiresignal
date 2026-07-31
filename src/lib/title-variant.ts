/**
 * 공고 제목의 변형 판정.
 *
 * ── 무엇을 푸는가 ──
 *
 * 회사는 같은 자리를 여러 건으로 올린다. 두 가지 패턴이 있다.
 *
 *   1) 제목이 완전히 같은 복수 공고
 *      cresta `Infrastructure Engineer/SRE` x3 (305일 / 157일 / 157일)
 *   2) 지역만 다른 변형
 *      ashby `Staff Design Engineer - Americas / Canada / EU`
 *
 * 둘 다 "한 직무에 자리가 여럿"이다. 화면에서 따로 나열하면 "직무가 여럿"으로
 * 읽히는데, 이 구분이 제안 논지를 바꾼다 - "여러 분야를 못 뽑는다"보다
 * "이 한 자리를 여러 번 시도하고도 못 뽑았다"가 훨씬 강한 근거다.
 *
 * ── 왜 어휘 목록인가 ──
 *
 * 접미사를 무조건 떼면 서로 다른 직무가 합쳐진다. 실측 예시:
 *
 *   scaleway  `Software Engineer - Compute Marketplace`      다른 자리
 *             `Software Engineer - Kubernetes Specialist`
 *   workos    `Product Engineer - Enterprise / Identity and Auth /
 *              Pipes & Vault / Feature Flags / Radar`         전부 다른 제품
 *   ashby     `Staff Design Engineer - Americas / Canada / EU` 같은 자리
 *
 * 형태만 보면 구분되지 않는다. 유일한 구분 기준이 "접미사가 지리 표현인가"뿐이라
 * 어휘 판정을 쓴다. 어휘 확장은 추측이 아니라 데이터 근거로만 한다 -
 * `npm run roles:audit` 이 놓친 병합 후보와 미인식 접미사 낱말 빈도를 뽑아준다.
 *
 * 이 모듈이 report-html.ts 에서 분리된 이유: 감사 스크립트가 같은 로직을 써야
 * 하는데, report-html.ts 는 import 시점에 main() 이 돌아 리포트를 써버린다.
 */

/**
 * 지역 표현 어휘.
 *
 * 실측 데이터에 나타난 지역 접미사 + 흔한 지리 표현으로만 구성한다. 목록에 없는
 * 접미사는 지역으로 보지 않으므로 묶이지 않는다.
 */
export const REGION_WORDS: ReadonlySet<string> = new Set([
  // 광역
  'americas', 'america', 'emea', 'apac', 'latam', 'anz', 'mena', 'global', 'worldwide',
  'na', 'eu', 'europe', 'european', 'union', 'international',
  'north', 'south', 'east', 'west', 'central', 'middle', 'nordics', 'benelux', 'dach',
  // 국가
  'us', 'usa', 'uk', 'ireland', 'germany', 'france', 'spain', 'portugal', 'poland',
  'romania', 'netherlands', 'sweden', 'norway', 'denmark', 'finland', 'switzerland',
  'italy', 'austria', 'belgium', 'czechia', 'bulgaria', 'hungary', 'greece', 'turkey',
  'israel', 'canada', 'mexico', 'brazil', 'argentina', 'chile', 'colombia', 'india',
  'japan', 'korea', 'singapore', 'australia', 'zealand', 'china', 'taiwan', 'philippines',
  'indonesia', 'vietnam', 'thailand', 'malaysia', 'uae', 'egypt', 'nigeria', 'africa',
  // 도시 (실측 등장분)
  'bucharest', 'cluj', 'iasi', 'london', 'berlin', 'paris', 'madrid', 'lisbon',
  'warsaw', 'dublin', 'amsterdam', 'stockholm', 'munich', 'zurich', 'tokyo',
  'bangalore', 'bengaluru', 'sydney', 'melbourne', 'toronto', 'vancouver',
  'francisco', 'seattle', 'austin', 'boston', 'chicago', 'denver', 'atlanta', 'nyc',
  // 근무 형태 수식어
  'remote', 'onsite', 'hybrid', 'based', 'only', 'region', 'timezone', 'timezones',
]);

/**
 * 접미사가 지역 표현인지 판정한다. 모든 낱말이 어휘에 있어야 참이다.
 *
 * 한 낱말이라도 벗어나면 거짓으로 두는 이유: 오판의 비용이 비대칭이다. 지역을
 * 놓치면 접히지 않은 채 보이지만(정보 손실 없음), 잘못 접으면 다른 직무가 하나로
 * 합쳐져 자리 하나가 화면에서 사라진다.
 *
 * 낱말 4개로 제한하는 이유: `(Pre-training / Data Research)` 처럼 긴 구절이
 * 우연히 전부 어휘에 걸리는 사고를 막는다. 실측 지역 라벨은 최대 3낱말이다
 * (`Europe/Middle East`, `Remote - North America`).
 */
export function isRegionLabel(raw: string): boolean {
  const words = raw
    .toLowerCase()
    // 하이픈도 낱말 구분자로 본다. `Remote - US` 를 놓치면 안 된다.
    .split(/[\s/&,+()\u2010-\u2015-]+/)
    .map((w) => w.replace(/[.]/g, ''))
    .filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  return words.every((w) => REGION_WORDS.has(w));
}

/** 제목을 "본문 + 지역"으로 분해한 결과 */
export interface TitleParts {
  /** 지역을 뗀 본문. 지역이 없으면 원문과 같다. */
  base: string;
  /** 떼어낸 지역 라벨. 없으면 null. */
  region: string | null;
}

/**
 * 제목 끝의 지역 표현을 떼어낸다.
 *
 * 대시 접미사를 볼 때 접미사 안에 다시 대시가 없어야 한다는 제약을 두지 않는다.
 * `Remote - North America` 같은 라벨이 통째로 지역이기 때문이다. 대신 긴 쪽부터
 * 짧은 쪽으로 후퇴하며 처음으로 지역 판정에 걸리는 분할을 쓴다.
 */
export function splitTitleRegion(title: string): TitleParts {
  const trimmed = title.trim();

  // 1) 끝 괄호: `... (Korea)`, `... (Europe/Middle East)`
  const paren = /^(.+?)\s*\(([^()]+)\)\s*$/.exec(trimmed);
  if (paren) {
    const [, head = '', suffix = ''] = paren;
    if (head && isRegionLabel(suffix)) {
      return { base: head.trim(), region: suffix.trim() };
    }
  }

  // 2) 끝 대시 구절. 왼쪽 대시부터 시도한다.
  //    `Engineer - Remote - US` 는 `- US` 가 아니라 `- Remote - US` 를 지역으로
  //    잡는 편이 옳다(본문이 `Engineer` 로 남는다). 그래서 가장 왼쪽,
  //    즉 가장 긴 지역 접미사를 우선한다.
  //
  //    괄호 안의 대시는 건너뛴다. 넘기지 않으면 `Engineer (Foo - US)` 에서
  //    base 가 `Engineer (Foo` 로 잘려 괄호가 깨진 제목이 화면에 나간다
  //    (isRegionLabel 은 괄호를 구분자로 지우므로 `US)` 를 지역으로 인정한다).
  let depth = 0;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;
    if (ch !== '-' && (ch < '\u2010' || ch > '\u2015')) continue;

    const head = trimmed.slice(0, i).trim();
    const suffix = trimmed.slice(i + 1).trim();
    if (head && suffix && isRegionLabel(suffix)) {
      return { base: head, region: suffix };
    }
  }

  return { base: trimmed, region: null };
}

/**
 * 직무 묶음 키. 대소문자·공백·구두점 변형만 흡수한다.
 *
 * 낱말을 지우지는 않는다. 여기서 더 공격적으로 정규화하면 서로 다른 직무가
 * 합쳐진다 - perplexity 의 `Member of Technical Staff (...)` 15건이 그 예로,
 * 괄호 안이 전부 다른 직무다.
 */
export function roleKey(base: string): string {
  return base
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/[(),.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
