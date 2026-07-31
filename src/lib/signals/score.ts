/**
 * 리드 스코어링.
 *
 * 핵심 가설: 채용 공고는 구매 의도 신호다. "60일째 안 채워진 React 공고"는
 * "React 작업량이 넘치는데 사람을 못 구하고 있다" = 외주 발주 가능 상태.
 *
 * ── 실측이 강제한 설계 결정 ──
 *
 * 1) 관측 나이와 보고 나이를 분리한다.
 *    ATS의 `first_published`는 requisition 최초 생성일이라 상시 공고에서 수년으로
 *    부풀려진다(Databricks 365일+ 123건). `updated_at`도 보드 일괄 갱신값이라 쓸 수
 *    없다(Stripe 540건 중 84%가 동일 날짜). 신뢰할 수 있는 staleness는 우리 스냅샷
 *    기반 관측 나이뿐이고, 보고 나이는 낮은 배점의 약한 사전확률로만 쓴다.
 *
 * 2) 가중치 재정규화를 쓰지 않는다.  ← 1차 구현에서 실패한 부분
 *    누락 신호의 배점을 남은 신호로 재분배했더니 "신호가 적을수록 만점받기 쉬운"
 *    역전이 발생했다. 실측에서 evergreen으로 걸러진 1226일 공고가 클러스터 신호
 *    하나만으로 100점을 받았고, 전체의 95%가 warm으로 뭉쳐 등급이 판별력을 잃었다.
 *    지금은 절대 배점을 쓰고(누락 = 0점), 등급은 "사용 가능한 배점 대비 비율"과
 *    "기여 신호 개수"를 함께 요구한다. 신호 하나로는 어떤 등급도 확정되지 않는다.
 *
 * 3) 클러스터는 회사 규모로 정규화한다.
 *    절대 건수를 쓰면 대기업이 항상 만점이다. Stripe는 상시 팀 확장 중이므로
 *    그 자체가 신호가 아니다. 신호는 "전체 채용 중 특정 계열의 비정상적 집중"이다.
 */

import {
  detectEvergreen,
  usableReportedAge,
  type EvergreenVerdict,
  isAgeSuspect,
} from './evergreen.js';

/** 이 일수 이상 관측되면 "채워지지 않고 있다"고 판단한다. */
export const STALE_THRESHOLD_DAYS = 60;

/** Hot 등급에 요구되는 최소 신뢰도. 관측 이력 없이 Hot을 주지 않는다. */
export const HOT_MIN_CONFIDENCE = 0.5;

/** Hot 등급에 요구되는 최소 기여 신호 개수. 단일 신호로는 Hot이 될 수 없다. */
export const HOT_MIN_SIGNALS = 3;

/** Warm 등급에 요구되는 최소 기여 신호 개수. */
export const WARM_MIN_SIGNALS = 2;

/** 사용 가능 배점 대비 획득 비율 임계값. */
export const RELATIVE_THRESHOLDS = { hot: 0.7, warm: 0.45 } as const;

const MS_PER_DAY = 86_400_000;

export function computeAgeDays(
  publishedAt: Date | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!publishedAt) return null;
  const diff = now.getTime() - publishedAt.getTime();
  if (diff < 0) return 0; // 시계 오차 방어
  return Math.floor(diff / MS_PER_DAY);
}

export type LeadGrade = 'hot' | 'warm' | 'cold';

export interface ScoringInput {
  title: string;
  companySlug: string;

  /** ATS 보고 게시 경과일. 약한 신호. evergreen이면 자동 무효화. */
  reportedAgeDays: number | null;

  /** 우리가 처음 관측한 뒤 경과 일수. 신뢰 가능한 1차 신호. 이력 없으면 null. */
  observedAgeDays: number | null;

  /**
   * Wayback 아카이브가 증명하는 최소 경과일. **하한값**이며 null은 "증거 없음"이지
   * "새 공고"가 아니다.
   *
   * 제3자가 남긴 독립 기록이므로 우리 관측과 동등하게 신뢰할 수 있다. 그래서
   * 실효 관측 나이를 `max(우리관측, 아카이브)`로 계산한다 — 이것이 60일 콜드스타트를
   * 우회하는 지점이다.
   */
  archiveAgeDays: number | null;

  /** 동일 title_fingerprint 재등록 횟수. null = 이력 없음. */
  repostCount: number | null;

  /** 같은 회사에서 동일 스택 계열로 열린 공고 수. */
  clusterSize: number | null;

  /** 클러스터 정규화용 분모. 회사의 전체 오픈 공고 수. */
  companyOpenJobs: number | null;

  /** close→reopen 횟수. null = 이력 없음. */
  reopenCount: number | null;

  /** 30일 전 대비 회사 오픈 공고 수 비율. null = 이력 없음. */
  companyGrowthRatio: number | null;
}

interface Component {
  key: string;
  label: string;
  weight: number;
  /** 0.0~1.0. null이면 신호 사용 불가. */
  ratio: number | null;
  detail: string;
}

export interface ScoreBreakdown {
  /** 절대 점수 (0~100). 누락 신호는 0점으로 계산된다. */
  score: number;
  /**
   * 사용 가능한 배점 대비 획득 비율 (0~1).
   * 이력이 없는 초기에는 `score`가 구조적으로 낮으므로 **정렬은 이 값으로** 한다.
   */
  relativeScore: number;
  grade: LeadGrade;
  /** 사용 가능한 신호의 배점 합 / 100 */
  confidence: number;
  /** 실제로 점수에 기여한(0점 초과) 신호 개수 */
  contributingSignals: number;
  /** 신호 부족으로 등급이 강등되었는지 */
  gradeCapped: boolean;
  evergreen: EvergreenVerdict;
  components: Array<{
    key: string;
    label: string;
    points: number;
    maxPoints: number;
    available: boolean;
    detail: string;
  }>;
  reasons: string[];
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** 관측 나이 → 비율. 30일 미만 0점, 60일 0.6, 120일 이상 만점. */
function stalenessRatio(ageDays: number): number {
  if (ageDays < 30) return 0;
  if (ageDays >= 120) return 1;
  if (ageDays <= STALE_THRESHOLD_DAYS) {
    return ((ageDays - 30) / (STALE_THRESHOLD_DAYS - 30)) * 0.6;
  }
  return 0.6 + ((ageDays - STALE_THRESHOLD_DAYS) / (120 - STALE_THRESHOLD_DAYS)) * 0.4;
}

/** 재게시 횟수 → 비율. 1회=0.6, 2회=0.85, 3회+=1.0 */
function repostRatio(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 0.6;
  if (count === 2) return 0.85;
  return 1;
}

/**
 * 클러스터 → 비율. 회사 규모로 정규화한다.
 *
 * 절대 2건 이상이면서, 전체 채용 중 차지하는 비중이 높을 때만 신호로 본다.
 * 10% 미만은 대기업의 일상적 분산 채용이므로 0점. 35% 이상이면 만점.
 */
function clusterRatio(
  clusterSize: number,
  companyOpenJobs: number | null,
): number {
  if (clusterSize < 2) return 0;
  // 분모가 없으면 소규모 보드로 가정하되 보수적으로 처리
  const total = companyOpenJobs && companyOpenJobs > 0 ? companyOpenJobs : clusterSize;
  const share = clusterSize / total;
  return clamp01((share - 0.1) / 0.25);
}

export function scoreLead(input: ScoringInput): ScoreBreakdown {
  const evergreen = detectEvergreen({
    title: input.title,
    reportedAgeDays: input.reportedAgeDays,
    companySlug: input.companySlug,
  });

  const reportedAge = usableReportedAge(input.reportedAgeDays, evergreen);

  // 실효 관측 나이 = max(우리 관측, 아카이브 하한).
  // 아카이브는 제3자 독립 기록이므로 우리 관측과 동등하게 취급한다.
  // 상시 공고로 판정된 건은 나이 자체가 의미 없으므로 아카이브도 적용하지 않는다.
  const archiveAge = evergreen.isEvergreen ? null : input.archiveAgeDays;
  const effectiveAges = [input.observedAgeDays, archiveAge].filter(
    (v): v is number => v !== null,
  );
  const effectiveAge = effectiveAges.length > 0 ? Math.max(...effectiveAges) : null;
  const ageSource =
    archiveAge !== null && archiveAge === effectiveAge
      ? '아카이브 증거'
      : '자체 관측';

  // 아카이브가 ATS 게시일보다 60일 이상 오래되면 ATS가 게시일을 리셋한 것이다.
  // 실측 사례: ashby:ramp "Security Engineer, Cloud" — ATS 113일 vs 아카이브 1006일.
  //
  // evergreen 이면 이 신호도 함께 무효화한다. 상시 공고는 특정 자리를 채우려는 게
  // 아니므로 게시일이 어떻게 움직였는지는 채용 실패의 증거가 아니다. 나이만 무효화하고
  // 이 신호를 남겨두면 "General Application" 같은 인재풀 공고가 10점을 얻어 리드로
  // 올라온다 — evergreen 필터를 우회하는 누출이다.
  const dateResetGap =
    !evergreen.isEvergreen &&
    input.archiveAgeDays !== null &&
    input.reportedAgeDays !== null
      ? input.archiveAgeDays - input.reportedAgeDays
      : null;

  const components: Component[] = [
    {
      key: 'observed_staleness',
      label: '관측 경과',
      weight: 35,
      ratio: effectiveAge === null ? null : stalenessRatio(effectiveAge),
      detail:
        effectiveAge === null
          ? '관측 이력 축적 중'
          : `${effectiveAge}일간 계속 열려 있음 (${ageSource})`,
    },
    {
      key: 'date_reset',
      label: '게시일 리셋',
      weight: 10,
      // 60일 초과 격차부터 신호로 본다. 365일 격차면 만점.
      ratio:
        dateResetGap === null ? null : clamp01((dateResetGap - 60) / 305),
      detail:
        dateResetGap === null
          ? evergreen.isEvergreen
            ? '상시 공고로 판정 — 제외'
            : '아카이브 증거 없음'
          : dateResetGap <= 60
            ? '게시일 일관됨'
            : `ATS 게시일이 아카이브보다 ${dateResetGap}일 최신 — requisition 재활용 흔적`,
    },
    {
      key: 'reported_age',
      label: '게시일(참고)',
      weight: 5,
      ratio: reportedAge === null ? null : clamp01((reportedAge - 30) / 150),
      detail: evergreen.isEvergreen
        ? `상시 공고로 판정 — 제외 (${evergreen.detail})`
        : reportedAge === null
          ? '게시일 미제공'
          : `ATS 게시 ${input.reportedAgeDays}일 경과`,
    },
    {
      key: 'repost',
      label: '재게시',
      weight: 20,
      ratio: input.repostCount === null ? null : repostRatio(input.repostCount),
      detail:
        input.repostCount === null
          ? '이력 축적 중'
          : input.repostCount === 0
            ? '재게시 없음'
            : `${input.repostCount}회 재게시 — 채용 실패 이력`,
    },
    {
      key: 'cluster',
      label: '집중 채용',
      weight: 20,
      ratio:
        input.clusterSize === null
          ? null
          : clusterRatio(input.clusterSize, input.companyOpenJobs),
      detail:
        input.clusterSize === null
          ? '계산 불가'
          : input.clusterSize < 2
            ? '단건 채용'
            : `동일 계열 ${input.clusterSize}건` +
              (input.companyOpenJobs
                ? ` / 전체 ${input.companyOpenJobs}건 (${Math.round((input.clusterSize / input.companyOpenJobs) * 100)}%)`
                : ''),
    },
    {
      key: 'reopen',
      label: '재오픈',
      weight: 5,
      ratio: input.reopenCount === null ? null : clamp01(input.reopenCount / 2),
      detail:
        input.reopenCount === null
          ? '이력 축적 중'
          : input.reopenCount === 0
            ? '재오픈 없음'
            : `${input.reopenCount}회 재오픈`,
    },
    {
      key: 'velocity',
      label: '채용 증가율',
      weight: 5,
      ratio:
        input.companyGrowthRatio === null
          ? null
          : clamp01((input.companyGrowthRatio - 1) / 0.5),
      detail:
        input.companyGrowthRatio === null
          ? '이력 축적 중'
          : `30일 대비 ${input.companyGrowthRatio.toFixed(2)}배`,
    },
  ];

  // --- 절대 배점. 누락 신호는 0점. 재분배하지 않는다. ---
  const scored = components.map((c) => {
    const available = c.ratio !== null;
    return {
      key: c.key,
      label: c.label,
      points: available ? (c.ratio as number) * c.weight : 0,
      maxPoints: c.weight,
      available,
      detail: c.detail,
    };
  });

  const availableWeight = components
    .filter((c) => c.ratio !== null)
    .reduce((sum, c) => sum + c.weight, 0);

  const rawScore = scored.reduce((sum, c) => sum + c.points, 0);
  const score = Math.round(Math.min(100, rawScore));
  const confidence = availableWeight / 100;
  const relativeScore = availableWeight === 0 ? 0 : rawScore / availableWeight;
  const contributingSignals = scored.filter(
    (c) => c.available && c.points > 0,
  ).length;

  // --- 등급: 비율 + 신호 개수 + 신뢰도를 모두 요구한다 ---
  let grade: LeadGrade = 'cold';
  let gradeCapped = false;
  /** 근거 목록 맨 앞에 올릴 경고. 읽는 사람이 가장 먼저 알아야 하는 값이다. */
  const reasonsPrefix: string[] = [];

  // 경과일이 재사용 의심 구간이면 Hot 을 주지 않는다.
  //
  // 이 리드의 최상위 근거는 "N일간 못 채웠다"인데, 2년을 넘으면 그 문장이 하나의
  // 채용 시도를 뜻한다고 볼 수 없다. 근거가 약한 것을 최상위 등급으로 올리면 목록
  // 전체의 신뢰가 깎인다 — 실측으로 1,527일(4.2년) 리드가 상위 5위에 올라 공개
  // 페이지 첫 화면에 실렸다.
  //
  // 리드 자체는 버리지 않는다. 등급만 내리고 화면에 의심을 명시한다.
  const ageSuspect = isAgeSuspect(effectiveAge);

  if (
    relativeScore >= RELATIVE_THRESHOLDS.hot &&
    contributingSignals >= HOT_MIN_SIGNALS &&
    confidence >= HOT_MIN_CONFIDENCE &&
    !ageSuspect
  ) {
    grade = 'hot';
  } else if (
    relativeScore >= RELATIVE_THRESHOLDS.warm &&
    contributingSignals >= WARM_MIN_SIGNALS
  ) {
    grade = 'warm';
    // Hot 비율 요건은 넘었지만 신호/신뢰도가 부족해 강등된 경우를 표시
    if (relativeScore >= RELATIVE_THRESHOLDS.hot) gradeCapped = true;
  }

  if (ageSuspect) {
    reasonsPrefix.push(
      `경과 ${effectiveAge}일 — 2년을 넘겨 requisition 재사용 가능성이 높습니다. ` +
        `URL 이 그 시점에 존재한 것은 사실이지만 하나의 채용 시도로 보기 어려워 Hot 을 주지 않습니다`,
    );
  }

  const reasons = scored
    .filter((c) => c.available && c.points > 0)
    .sort((a, b) => b.points - a.points)
    .map((c) => c.detail);
  reasons.unshift(...reasonsPrefix);

  if (gradeCapped) {
    reasons.push(
      `신호 ${contributingSignals}개 / 신뢰도 ${Math.round(confidence * 100)}% — ` +
        `관측 이력 누적 시 Hot 승급 가능`,
    );
  }

  return {
    score,
    relativeScore: Math.round(relativeScore * 1000) / 1000,
    grade,
    confidence,
    contributingSignals,
    gradeCapped,
    evergreen,
    components: scored.map((c) => ({
      ...c,
      points: Math.round(c.points * 10) / 10,
    })),
    reasons: reasons.length > 0 ? reasons : ['신호 임계 미달'],
  };
}
