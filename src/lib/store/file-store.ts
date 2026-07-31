/**
 * 파일 기반 스냅샷 저장소.
 *
 * 목적: Postgres 프로비저닝을 기다리지 않고 **오늘** 관측 시계를 시작한다.
 * 이 제품의 핵심 신호는 60일치 관측 이력을 요구하므로 시작일이 곧 런치일을 결정한다.
 *
 * 저장 형태:
 *   data/state.json        누적 관측 상태 (전체 재작성)
 *   data/snapshots.jsonl    일별 관측 원장 (append-only, 감사/재구축용)
 *   data/runs.jsonl         스캔 실행 로그 (append-only)
 *
 * state.json은 파생 데이터이므로 손상되어도 snapshots.jsonl로 재구축할 수 있다.
 * 그래서 원장은 절대 덮어쓰지 않고 append만 한다.
 *
 * 한계: 단일 프로세스 전제. 동시 스캔은 지원하지 않는다. Postgres 구현으로
 * 넘어갈 때 해소된다. 1인 운영 초기에는 문제되지 않는다.
 */

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { AtsProvider, NormalizedJob } from '../ats/types.js';
import {
  jobKeyString,
  type BoardDiff,
  type JobObservation,
  type LifecycleRecord,
  type ScanRunRecord,
  type SnapshotStore,
  type StoreState,
} from './types.js';

interface PersistedState {
  version: 1;
  lastScanAt: string | null;
  observations: JobObservation[];
  lifecycles: LifecycleRecord[];
}

/**
 * 공고가 사라진 뒤 충원으로 확정하기까지의 유예 시간.
 *
 * 20시간으로 둔 이유: 일 1회 스캔이므로 "연속 2회 스캔에서 안 보였다"와 사실상
 * 동일하다. 24시간으로 하면 스케줄 지터 때문에 유예가 3회로 늘어난다.
 *
 * 이 값을 짧게 하면 깜빡임이 충원으로 기록되고(신호 오염, 되돌릴 수 없음),
 * 길게 하면 실제 충원 감지가 늦어진다. 오염이 더 비싸므로 보수적으로 잡는다.
 */
const CLOSE_GRACE_MS = 20 * 60 * 60 * 1000;

function lifecycleKey(
  provider: AtsProvider,
  slug: string,
  fingerprint: string,
): string {
  return `${provider}:${slug}:${fingerprint}`;
}

export class FileSnapshotStore implements SnapshotStore {
  private state: StoreState = {
    lastScanAt: null,
    observations: new Map(),
    lifecycles: new Map(),
  };

  private loaded = false;
  private dirty = false;

  constructor(private readonly dataDir: string) {}

  private get statePath(): string {
    return path.join(this.dataDir, 'state.json');
  }
  private get snapshotsPath(): string {
    return path.join(this.dataDir, 'snapshots.jsonl');
  }
  private get runsPath(): string {
    return path.join(this.dataDir, 'runs.jsonl');
  }

  async load(): Promise<StoreState> {
    await mkdir(this.dataDir, { recursive: true });

    try {
      const raw = await readFile(this.statePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedState;

      if (parsed.version !== 1) {
        throw new Error(
          `알 수 없는 state.json 버전: ${parsed.version}. 마이그레이션이 필요합니다.`,
        );
      }

      this.state = {
        lastScanAt: parsed.lastScanAt,
        observations: new Map(
          parsed.observations.map((o) => [
            jobKeyString(o.key),
            // 하위 호환: missingSince는 유예 로직 도입과 함께 추가된 필드다.
            // undefined가 남아 있으면 유예 계산이 NaN이 되어 충원 판정이 깨진다.
            { ...o, missingSince: o.missingSince ?? null },
          ]),
        ),
        lifecycles: new Map(
          parsed.lifecycles.map((l) => [
            lifecycleKey(l.atsProvider, l.companySlug, l.titleFingerprint),
            l,
          ]),
        ),
      };
    } catch (err) {
      // 파일이 없으면 첫 실행이다. 그 외 오류는 덮어쓰면 데이터 유실이므로 던진다.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    this.loaded = true;
    return this.state;
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error('load()를 먼저 호출해야 합니다.');
    }
  }

  async applyBoardScan(input: {
    atsProvider: AtsProvider;
    companySlug: string;
    jobs: NormalizedJob[];
    tagsByExternalId: Map<string, string[]>;
    observedAt: Date;
  }): Promise<BoardDiff> {
    this.assertLoaded();

    const { atsProvider, companySlug, jobs, tagsByExternalId, observedAt } = input;
    const nowIso = observedAt.toISOString();
    const diff: BoardDiff = {
      newJobs: 0,
      stillOpen: 0,
      closed: 0,
      missing: 0,
      recovered: 0,
      reopened: 0,
      reposts: 0,
    };

    const seenKeys = new Set<string>();
    const ledgerLines: string[] = [];

    // --- 1) 이번 스캔에서 보인 공고 처리 ---
    for (const job of jobs) {
      const key = {
        atsProvider,
        companySlug,
        externalId: job.externalId,
      };
      const keyStr = jobKeyString(key);
      seenKeys.add(keyStr);

      const tags = tagsByExternalId.get(job.externalId) ?? [];
      const existing = this.state.observations.get(keyStr);

      if (!existing) {
        this.state.observations.set(keyStr, {
          key,
          title: job.title,
          titleFingerprint: job.titleFingerprint,
          jobUrl: job.jobUrl,
          department: job.department,
          locationRaw: job.locationRaw,
          workplaceType: job.workplaceType,
          sourcePublishedAt: job.sourcePublishedAt?.toISOString() ?? null,
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
          seenCount: 1,
          missingSince: null,
          closedAt: null,
          reopenCount: 0,
          tags,
        });
        diff.newJobs++;
      } else {
        // 충원으로 확정됐던 공고가 다시 보이면 재오픈이다.
        if (existing.closedAt !== null) {
          existing.reopenCount++;
          existing.closedAt = null;
          diff.reopened++;
        } else if (existing.missingSince !== null) {
          // 유예 중 복귀 = ATS 깜빡임. 재오픈으로 세지 않는다.
          // 이걸 재오픈으로 세면 신호가 노이즈로 오염된다.
          diff.recovered++;
        }
        existing.missingSince = null;
        existing.lastSeenAt = nowIso;
        existing.seenCount++;
        // 제목/URL은 변경될 수 있으므로 최신값을 유지한다.
        existing.title = job.title;
        existing.jobUrl = job.jobUrl;
        if (tags.length > 0) existing.tags = tags;
        diff.stillOpen++;
      }

      ledgerLines.push(
        JSON.stringify({
          t: nowIso,
          k: keyStr,
          fp: job.titleFingerprint,
          open: 1,
        }),
      );

      // --- 지문 단위 이력 갱신 (재게시 탐지) ---
      const lcKey = lifecycleKey(atsProvider, companySlug, job.titleFingerprint);
      const lc = this.state.lifecycles.get(lcKey);
      if (!lc) {
        this.state.lifecycles.set(lcKey, {
          atsProvider,
          companySlug,
          titleFingerprint: job.titleFingerprint,
          externalIds: [job.externalId],
          repostCount: 0,
          firstSeenAt: nowIso,
          lastSeenAt: nowIso,
        });
      } else {
        lc.lastSeenAt = nowIso;
        if (!lc.externalIds.includes(job.externalId)) {
          // 같은 자리인데 새 공고 ID가 등장 = 재게시 후보.
          //
          // `every`를 쓰는 것이 중요하다. `some`이면 지역별 복수 채용에서 오탐이
          // 난다 — "Backend Engineer (Berlin)"과 "(NYC)"는 지문이 같은데, 한쪽이
          // 닫히고 다른 지역 공고가 새로 열리면 재게시로 오인된다. 실측에서 이
          // 패턴이 확인됐다(Stripe "account executive enterprise hunter" x3).
          //
          // 모든 이전 ID가 닫혀 있어야 "그 자리를 못 채워서 다시 올렸다"가 된다.
          const allPreviousClosed = lc.externalIds.every((id) => {
            const prev = this.state.observations.get(
              jobKeyString({ atsProvider, companySlug, externalId: id }),
            );
            return prev !== undefined && prev.closedAt !== null;
          });
          lc.externalIds.push(job.externalId);
          if (allPreviousClosed) {
            lc.repostCount++;
            diff.reposts++;
          }
        }
      }
    }

    // --- 2) 이번 스캔에서 사라진 공고 처리 (유예 후 충원 확정) ---
    //
    // 이 판단은 보드 조회가 성공했을 때만 유효하다. 파이프라인은 실패한 보드에
    // 대해 이 메서드를 호출하지 않는다.
    //
    // 사라진 즉시 충원 처리하지 않는다. ATS가 같은 요청에 다른 집합을 돌려주는
    // 깜빡임이 실측으로 확인됐기 때문이다(같은 날 재스캔에서 충원 7 / 신규 7).
    // CLOSE_GRACE_MS가 지나도록 계속 안 보일 때만 확정한다.
    for (const [keyStr, obs] of this.state.observations) {
      if (
        obs.key.atsProvider !== atsProvider ||
        obs.key.companySlug !== companySlug
      ) {
        continue;
      }
      if (seenKeys.has(keyStr)) continue;
      if (obs.closedAt !== null) continue; // 이미 충원 확정됨

      if (obs.missingSince === null) {
        // 첫 실종 관측 — 유예 시작. 원장에는 아직 기록하지 않는다.
        obs.missingSince = nowIso;
        diff.missing++;
        continue;
      }

      const missingMs =
        observedAt.getTime() - new Date(obs.missingSince).getTime();
      if (missingMs < CLOSE_GRACE_MS) {
        diff.missing++;
        continue;
      }

      obs.closedAt = nowIso;
      diff.closed++;
      ledgerLines.push(
        JSON.stringify({ t: nowIso, k: keyStr, fp: obs.titleFingerprint, open: 0 }),
      );
    }

    if (ledgerLines.length > 0) {
      await appendFile(
        this.snapshotsPath,
        ledgerLines.join('\n') + '\n',
        'utf8',
      );
    }

    this.state.lastScanAt = nowIso;
    this.dirty = true;
    return diff;
  }

  async recordRun(run: ScanRunRecord): Promise<void> {
    this.assertLoaded();
    await appendFile(this.runsPath, JSON.stringify(run) + '\n', 'utf8');
  }

  /**
   * state.json을 원자적으로 교체한다.
   * 쓰기 중 프로세스가 죽어도 기존 상태가 남아야 하므로 임시파일 + rename을 쓴다.
   */
  async flush(): Promise<void> {
    this.assertLoaded();
    if (!this.dirty) return;

    const payload: PersistedState = {
      version: 1,
      lastScanAt: this.state.lastScanAt,
      observations: [...this.state.observations.values()],
      lifecycles: [...this.state.lifecycles.values()],
    };

    const tmp = `${this.statePath}.tmp`;
    await writeFile(tmp, JSON.stringify(payload), 'utf8');
    await rename(tmp, this.statePath);
    this.dirty = false;
  }

  /**
   * 시드에서 제거된 보드의 관측을 정리한다.
   *
   * 왜 필요한가: 파이프라인은 시드에 있는 보드만 스캔한다. 시드에서 빠진 보드의
   * 공고는 영원히 "열려 있음" 상태로 남아 관측 나이가 무한히 늘어난다. 그 상태로
   * 스코어링에 들어가면 실제로는 추적하지도 않는 회사의 공고가 최상위 리드로 올라온다.
   *
   * 시드 변경은 반복되는 일이므로(타겟 재정의, 보드 폐쇄) 일반 로직으로 둔다.
   *
   * @param activeBoards `provider:slug` 형식의 활성 보드 집합
   */
  pruneBoards(
    activeBoards: ReadonlySet<string>,
    options: { force?: boolean } = {},
  ): {
    removedObservations: number;
    removedLifecycles: number;
    boards: string[];
    /** 안전밸브가 작동해 정리를 건너뛴 경우 */
    aborted: boolean;
    abortReason: string | null;
  } {
    this.assertLoaded();

    // --- 안전밸브 ---
    //
    // 정리는 파괴적이고 되돌릴 수 없다. 시드 파일이 잘못 쓰이면(프로브 대량 실패,
    // JSON 손상, 실수) 누적 관측 전체가 한 번에 날아간다. 무인 스케줄 실행에서는
    // 사람이 개입할 수 없으므로, 삭제 규모가 과도하면 스스로 멈추는 게 맞다.
    //
    // 이 임계를 넘는 정상적인 상황은 의도적인 타겟 재정의뿐이고, 그때는 사람이
    // force를 붙여 실행하면 된다.
    const orphanKeys: string[] = [];
    const orphanBoardSet = new Set<string>();
    for (const [keyStr, obs] of this.state.observations) {
      const board = `${obs.key.atsProvider}:${obs.key.companySlug}`;
      if (activeBoards.has(board)) continue;
      orphanKeys.push(keyStr);
      orphanBoardSet.add(board);
    }

    const total = this.state.observations.size;
    const ratio = total > 0 ? orphanKeys.length / total : 0;
    const PRUNE_SAFETY_RATIO = 0.5;

    if (!options.force && total > 0 && ratio > PRUNE_SAFETY_RATIO) {
      return {
        removedObservations: 0,
        removedLifecycles: 0,
        boards: [...orphanBoardSet].sort(),
        aborted: true,
        abortReason:
          `관측 ${orphanKeys.length}/${total}건(${Math.round(ratio * 100)}%)이 정리 대상입니다. ` +
          `안전 임계 ${PRUNE_SAFETY_RATIO * 100}%를 초과해 중단했습니다. ` +
          `시드 파일이 의도한 대로인지 확인하고, 맞다면 --force-prune 으로 재실행하세요.`,
      };
    }

    const orphanBoards = orphanBoardSet;
    let removedObservations = 0;
    let removedLifecycles = 0;

    for (const keyStr of orphanKeys) {
      this.state.observations.delete(keyStr);
      removedObservations++;
    }

    for (const [lcKey, lc] of this.state.lifecycles) {
      const board = `${lc.atsProvider}:${lc.companySlug}`;
      if (activeBoards.has(board)) continue;
      this.state.lifecycles.delete(lcKey);
      removedLifecycles++;
    }

    if (removedObservations > 0 || removedLifecycles > 0) {
      this.dirty = true;
    }

    // snapshots.jsonl은 건드리지 않는다. append-only 원장이므로 과거 기록은
    // 감사 목적으로 보존한다. 필요하면 원장에서 재구축할 수 있다.
    return {
      removedObservations,
      removedLifecycles,
      boards: [...orphanBoards].sort(),
      aborted: false,
      abortReason: null,
    };
  }

  /** 스코어링에 필요한 조회 헬퍼 */
  getObservation(keyStr: string): JobObservation | undefined {
    return this.state.observations.get(keyStr);
  }

  getRepostCount(
    provider: AtsProvider,
    slug: string,
    fingerprint: string,
  ): number | null {
    const lc = this.state.lifecycles.get(
      lifecycleKey(provider, slug, fingerprint),
    );
    return lc ? lc.repostCount : null;
  }

  get lastScanAt(): string | null {
    return this.state.lastScanAt;
  }

  get observationCount(): number {
    return this.state.observations.size;
  }
}
