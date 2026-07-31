/**
 * 스냅샷 저장소 계약.
 *
 * 왜 추상화하는가 — 사업적 이유가 기술적 이유보다 크다:
 *
 * 이 제품의 핵심 신호(관측 나이 / 재게시 / 충원)는 매일 스냅샷을 쌓아야만
 * 생긴다. 60일이 지나야 첫 Hot 리드가 나온다. 즉 **스냅샷 시계를 하루라도 늦게
 * 시작하면 런치가 그만큼 늦어진다.** Postgres 프로비저닝을 기다릴 이유가 없다.
 *
 * 그래서 저장소를 인터페이스로 두고, 오늘 당장 돌아가는 파일 구현으로 시계를
 * 시작한 뒤, 인프라가 준비되면 Postgres 구현으로 갈아탄다. 스캔 파이프라인은
 * 어느 쪽인지 알 필요가 없다.
 */

import type { AtsProvider, NormalizedJob } from '../ats/types.js';

/** 공고의 안정적 식별자. ATS + 보드 + 공고ID 조합. */
export interface JobKey {
  atsProvider: AtsProvider;
  companySlug: string;
  externalId: string;
}

export function jobKeyString(key: JobKey): string {
  return `${key.atsProvider}:${key.companySlug}:${key.externalId}`;
}

/**
 * 공고 1건의 누적 관측 상태.
 * 스냅샷 원장에서 파생되는 요약이며, 스코어링이 직접 소비하는 형태다.
 */
export interface JobObservation {
  key: JobKey;

  title: string;
  /** 재게시 판정 조인 키 (정규화된 제목) */
  titleFingerprint: string;
  jobUrl: string;
  department: string | null;
  locationRaw: string | null;
  workplaceType: string;

  /** ATS가 보고한 게시일 (신뢰도 낮음, 참고용) */
  sourcePublishedAt: string | null;

  /** 우리가 이 공고를 처음 본 시각 — 관측 나이의 기준점 */
  firstSeenAt: string;
  /** 마지막으로 열려 있는 것을 확인한 시각 */
  lastSeenAt: string;
  /** 열려 있는 상태로 관측된 총 스캔 횟수 */
  seenCount: number;

  /**
   * 공고가 보이지 않기 시작한 시각. 아직 충원으로 확정하지 않은 유예 상태다.
   *
   * 왜 필요한가 — 실측 문제: 같은 날 두 번 스캔했는데 신규 7건 / 충원 7건이
   * 나왔다. ATS가 같은 요청에 미묘하게 다른 집합을 돌려주는 것(페이징 변동,
   * 캐시 계층 불일치)으로 보인다. 사라진 즉시 충원 처리하면 이런 깜빡임이
   * closedAt과 reopenCount를 오염시키고, 그 오염은 append-only 이력에 굳어져
   * 되돌릴 수 없다.
   *
   * 그래서 "연속으로 사라졌고 충분한 시간이 지났을 때"만 충원으로 확정한다.
   */
  missingSince: string | null;

  /** 충원으로 확정한 시각. null이면 아직 열려 있음(유예 상태 포함). */
  closedAt: string | null;
  /** close 확정 후 다시 나타난 횟수. 유예 중 복귀는 세지 않는다. */
  reopenCount: number;

  /** 추출된 기술스택 태그 */
  tags: string[];
}

/**
 * 제목 지문 단위 이력. 재게시 탐지의 근거.
 *
 * 회사가 공고를 내렸다가 새 ID로 다시 올리면 externalId는 바뀌지만
 * titleFingerprint는 유지된다. 그 사이클을 세는 것이 "채용 실패" 신호다.
 */
export interface LifecycleRecord {
  atsProvider: AtsProvider;
  companySlug: string;
  titleFingerprint: string;
  /** 이 지문으로 관측된 서로 다른 externalId 목록 (등장 순) */
  externalIds: string[];
  /** 닫힌 뒤 새 ID로 다시 열린 횟수 */
  repostCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** 스캔 1회의 감사 기록. 드리프트·장애 추적용. */
export interface ScanRunRecord {
  runId: string;
  startedAt: string;
  finishedAt: string;
  boardsAttempted: number;
  boardsSucceeded: number;
  jobsObserved: number;
  jobsNew: number;
  jobsClosed: number;
  jobsReopened: number;
  /** 사라졌지만 유예 중 (충원 미확정) */
  jobsMissing: number;
  /**
   * 유예 중 다시 나타난 건수 = ATS 깜빡임 지표.
   * 이 값이 지속적으로 크면 해당 ATS 응답이 불안정하다는 뜻이므로 유예 시간을
   * 늘려야 한다. 운영 지표로 추적한다.
   */
  jobsRecovered: number;
  warnings: string[];
  failures: Array<{ board: string; message: string; permanent: boolean }>;
}

export interface StoreState {
  /** 마지막 스캔 시각 */
  lastScanAt: string | null;
  observations: Map<string, JobObservation>;
  lifecycles: Map<string, LifecycleRecord>;
}

export interface SnapshotStore {
  /** 저장소를 초기화하고 기존 상태를 읽어온다. */
  load(): Promise<StoreState>;

  /**
   * 한 보드의 스캔 결과를 반영한다.
   *
   * 호출자가 아니라 저장소가 diff를 계산해야 한다. "이번에 안 보인 공고를
   * 닫힌 것으로 처리"하는 판단은 보드 조회가 **성공했을 때만** 유효하기 때문이다.
   * 조회 실패 시 이 메서드를 호출하면 전체 공고가 충원된 것으로 오판된다.
   */
  applyBoardScan(input: {
    atsProvider: AtsProvider;
    companySlug: string;
    jobs: NormalizedJob[];
    tagsByExternalId: Map<string, string[]>;
    observedAt: Date;
  }): Promise<BoardDiff>;

  /** 스캔 감사 기록을 남긴다. */
  recordRun(run: ScanRunRecord): Promise<void>;

  /** 변경사항을 영속화한다. */
  flush(): Promise<void>;
}

export interface BoardDiff {
  newJobs: number;
  stillOpen: number;
  /** 충원으로 확정된 건수 */
  closed: number;
  /** 사라졌지만 유예 중인 건수 (아직 충원 아님) */
  missing: number;
  /** 유예 중 다시 나타난 건수. 깜빡임 지표이므로 별도로 센다. */
  recovered: number;
  reopened: number;
  reposts: number;
}
