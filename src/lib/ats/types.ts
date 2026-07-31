/**
 * ATS 커넥터 공통 계약.
 *
 * 설계 원칙:
 * 1. 모든 커넥터는 서로 다른 스키마를 `NormalizedJob` 하나로 수렴시킨다.
 * 2. 스키마 드리프트는 예외가 아니라 상수다. 필드가 사라져도 스캔 전체가
 *    죽지 않도록 개별 공고 단위로 실패를 격리하고 `warnings`로 보고한다.
 * 3. `sourcePublishedAt`이 이 시스템의 심장이다. 이 값이 없으면 staleness를
 *    계산할 수 없으므로 `first_seen_at` 폴백을 파이프라인에서 처리한다.
 */

export const ATS_PROVIDERS = [
  'greenhouse',
  'lever',
  'ashby',
  'smartrecruiters',
] as const;

export type AtsProvider = (typeof ATS_PROVIDERS)[number];

/** 근무 형태. ATS별 표기가 제각각이라 4가지로 수렴시킨다. */
export type WorkplaceType = 'remote' | 'hybrid' | 'onsite' | 'unknown';

export interface NormalizedJob {
  atsProvider: AtsProvider;
  /** ATS 내 회사 식별자 (job board slug) */
  companySlug: string;
  /** ATS가 회사명을 주는 경우에만 채워진다 */
  companyName: string | null;
  /** ATS 내 공고 고유 ID. 재게시되면 이 값이 바뀐다. */
  externalId: string;
  title: string;
  /**
   * 재게시 탐지용 지문. 제목에서 요구사항 번호·레벨 표기·괄호를 제거한 정규형.
   * external_id가 바뀌어도 이 값은 유지되므로 lifecycle 조인 키로 쓴다.
   */
  titleFingerprint: string;
  department: string | null;
  team: string | null;
  employmentType: string | null;
  /** ATS가 준 원본 위치 문자열 (표시용) */
  locationRaw: string | null;
  /** 파싱된 위치 목록 (필터용) */
  locations: string[];
  workplaceType: WorkplaceType;
  /** ATS가 보고한 최초 게시 시각. staleness 계산의 1차 소스. */
  sourcePublishedAt: Date | null;
  /** ATS가 보고한 최종 수정 시각 (제공하는 곳만) */
  sourceUpdatedAt: Date | null;
  jobUrl: string;
  applyUrl: string | null;
  /** 기술스택 추출용 평문 본문. 없으면 null. */
  descriptionText: string | null;
}

export interface FetchJobsOptions {
  /**
   * 본문까지 가져올지 여부.
   * 일일 스캔은 false(가벼움), 기술스택 추출이 필요한 회차만 true.
   * Greenhouse는 본문 포함 시 페이로드가 크게 늘어난다.
   */
  includeContent?: boolean;
  signal?: AbortSignal;
}

export interface FetchJobsResult {
  provider: AtsProvider;
  companySlug: string;
  jobs: NormalizedJob[];
  /**
   * 개별 공고 파싱 실패 등 치명적이지 않은 문제.
   * 이 값이 급증하면 ATS 스키마가 바뀐 신호이므로 알림을 띄운다.
   */
  warnings: string[];
  /** 원본 응답에 들어있던 공고 수 (정규화 실패분 포함) */
  rawCount: number;
  fetchedAt: Date;
  durationMs: number;
}

export interface AtsConnector {
  readonly provider: AtsProvider;
  /** 사람이 볼 수 있는 채용 보드 URL */
  boardUrl(companySlug: string): string;
  fetchJobs(
    companySlug: string,
    options?: FetchJobsOptions,
  ): Promise<FetchJobsResult>;
}

/** 회사 전체 조회가 실패했을 때 (네트워크, 404, 스키마 붕괴) */
export class AtsFetchError extends Error {
  constructor(
    message: string,
    readonly provider: AtsProvider,
    readonly companySlug: string,
    // Error.cause를 의도적으로 재정의한다. 원인 예외를 구조화해 보관해야
    // 파이프라인이 재시도 가능 여부를 판단할 수 있다.
    override readonly cause?: unknown,
    /** HTTP 상태코드가 있으면 기록 (404 = 슬러그 오류, 429 = 레이트리밋) */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'AtsFetchError';
  }

  /** 슬러그가 잘못됐거나 보드가 사라진 경우 — 재시도 무의미, 시드에서 제거 대상 */
  get isPermanent(): boolean {
    return this.status === 404 || this.status === 410;
  }
}
