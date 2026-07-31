/**
 * 일일 스캔 파이프라인.
 *
 *   npx tsx src/pipeline/scan.ts            # 전체 보드 스캔 + 스냅샷 저장
 *   npx tsx src/pipeline/scan.ts --dry-run  # 저장 없이 결과만 확인
 *   npx tsx src/pipeline/scan.ts --report   # 스캔 후 현재 리드 상위 출력
 *
 * 이 스크립트를 **매일 1회** 돌리는 것이 이 제품의 전부다. 관측 나이·재게시·충원
 * 신호는 스냅샷 누적에서만 나오므로, 하루 빠뜨리면 그만큼 신호 품질이 떨어진다.
 *
 * ── 가장 중요한 안전장치 ──
 *
 * 보드 조회가 실패하면 그 보드는 **건너뛴다**. 스냅샷에 반영하지 않는다.
 * 실패를 "공고 없음"으로 처리하면 해당 회사의 모든 공고가 한꺼번에 충원된 것으로
 * 기록되고, 그 오염은 되돌릴 수 없다(재게시 카운터까지 망가진다).
 * Lever/SmartRecruiters는 잘못된 슬러그에도 200 빈배열을 주므로, 빈 응답 역시
 * 보수적으로 다룬다.
 */

import { readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { mapWithConcurrency } from '../lib/ats/http.js';
import { getConnector, isAtsProvider } from '../lib/ats/registry.js';
import { computeAgeDays, scoreLead } from '../lib/signals/score.js';
import {
  categorize,
  detectBoardWideTags,
  extractTechStack,
} from '../lib/signals/stack.js';
import { isDemoBoard } from '../lib/signals/evergreen.js';
import { classifyRole } from '../lib/signals/role.js';
import { FileSnapshotStore } from '../lib/store/file-store.js';
import { ArchiveCache } from '../lib/store/archive-cache.js';
import { jobKeyString, type ScanRunRecord } from '../lib/store/types.js';
import {
  AtsFetchError,
  type AtsProvider,
  type FetchJobsResult,
  type NormalizedJob,
} from '../lib/ats/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_DIR = path.join(ROOT, 'data');

interface SeedCompany {
  atsProvider: string;
  slug: string;
  displayName?: string;
}

async function loadSeeds(): Promise<SeedCompany[]> {
  const raw = await readFile(path.join(ROOT, 'seeds/companies.json'), 'utf8');
  const parsed = JSON.parse(raw) as { companies: SeedCompany[] };
  return parsed.companies.filter(
    (c) => isAtsProvider(c.atsProvider) && !isDemoBoard(c.slug),
  );
}

/** 보드 내 태그 계산 + 보드 전역 태그 제외 후 클러스터 크기 산출 */
function analyzeBoard(jobs: NormalizedJob[]): {
  tagsByExternalId: Map<string, string[]>;
  clusterByExternalId: Map<string, number | null>;
} {
  const tagsByExternalId = new Map<string, string[]>();
  for (const job of jobs) {
    tagsByExternalId.set(
      job.externalId,
      extractTechStack(job.descriptionText, job.companySlug),
    );
  }

  // 회사 배경 설명에서 온 태그(보드 40% 초과 등장)는 클러스터 신호가 될 수 없다.
  const boardWide = detectBoardWideTags(tagsByExternalId.values(), jobs.length);

  const keysOf = (job: NormalizedJob): string[] => {
    const tags = (tagsByExternalId.get(job.externalId) ?? []).filter(
      (t) => !boardWide.has(t),
    );
    return tags.length === 0 ? [] : [...categorize(tags).keys()].map(String);
  };

  const categoryCounts = new Map<string, number>();
  for (const job of jobs) {
    for (const key of new Set(keysOf(job))) {
      categoryCounts.set(key, (categoryCounts.get(key) ?? 0) + 1);
    }
  }

  const clusterByExternalId = new Map<string, number | null>();
  for (const job of jobs) {
    const keys = keysOf(job);
    clusterByExternalId.set(
      job.externalId,
      keys.length ? Math.max(...keys.map((k) => categoryCounts.get(k) ?? 1)) : null,
    );
  }

  return { tagsByExternalId, clusterByExternalId };
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const withReport = argv.includes('--report');
  // 안전밸브 우회. 의도적인 타겟 재정의 시에만 사람이 붙인다.
  const forcePrune = argv.includes('--force-prune');
  const exportLeads = argv.includes('--export');

  const seeds = await loadSeeds();
  const store = new FileSnapshotStore(DATA_DIR);
  await store.load();

  const runId = randomUUID();
  const startedAt = new Date();

  console.log(
    `\nHireSignal 일일 스캔 — ${seeds.length}개 보드${dryRun ? ' (DRY RUN)' : ''}\n` +
      `이전 스캔: ${store.lastScanAt ?? '없음 (첫 실행)'}\n` +
      `누적 관측 공고: ${store.observationCount}건\n`,
  );

  // 시드에서 빠진 보드의 관측을 먼저 정리한다. 방치하면 추적하지도 않는 회사의
  // 공고가 관측 나이만 무한히 늘어나 최상위 리드로 올라온다.
  if (!dryRun) {
    const activeBoards = new Set(
      seeds.map((s) => `${s.atsProvider}:${s.slug}`),
    );
    const pruned = store.pruneBoards(activeBoards, { force: forcePrune });

    if (pruned.aborted) {
      // 안전밸브 작동. 스캔은 계속한다 — 고아 관측이 남는 것보다 그날 관측을
      // 놓치는 것이 더 비싸다.
      console.log(`  PRUNE 중단: ${pruned.abortReason}`);
      console.log(
        `        대상 보드: ${pruned.boards.slice(0, 6).join(', ')}` +
          (pruned.boards.length > 6 ? ` 외 ${pruned.boards.length - 6}개` : ''),
      );
    } else if (pruned.removedObservations > 0) {
      console.log(
        `  PRUNE 시드 제외 보드 ${pruned.boards.length}개 정리 — ` +
          `관측 ${pruned.removedObservations}건, 이력 ${pruned.removedLifecycles}건 제거`,
      );
      console.log(
        `        ${pruned.boards.slice(0, 8).join(', ')}` +
          (pruned.boards.length > 8 ? ` 외 ${pruned.boards.length - 8}개` : ''),
      );
    }
  }

  const outcomes = await mapWithConcurrency(
    seeds,
    Number(process.env.SCAN_CONCURRENCY ?? 6),
    async (seed) => ({
      seed,
      result: await getConnector(seed.atsProvider as AtsProvider).fetchJobs(
        seed.slug,
        { includeContent: true },
      ),
    }),
  );

  const run: ScanRunRecord = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: '',
    boardsAttempted: seeds.length,
    boardsSucceeded: 0,
    jobsObserved: 0,
    jobsNew: 0,
    jobsClosed: 0,
    jobsReopened: 0,
    jobsMissing: 0,
    jobsRecovered: 0,
    warnings: [],
    failures: [],
  };

  // 리포트용으로 성공한 보드 결과를 보관
  const succeeded: Array<{
    seed: SeedCompany;
    result: FetchJobsResult;
    clusters: Map<string, number | null>;
    tags: Map<string, string[]>;
  }> = [];

  for (const [i, outcome] of outcomes.entries()) {
    const seed = seeds[i] as SeedCompany;
    const label = `${seed.atsProvider}:${seed.slug}`;

    if (!outcome.ok) {
      const err = outcome.error;
      const permanent = err instanceof AtsFetchError && err.isPermanent;
      const message = err instanceof Error ? err.message : String(err);
      run.failures.push({ board: label, message, permanent });
      console.log(
        `  SKIP  ${label.padEnd(32)} 조회 실패 — 스냅샷 미반영` +
          `${permanent ? ' [영구실패: 시드 제거 검토]' : ''}`,
      );
      continue;
    }

    const { result } = outcome.value;
    run.boardsSucceeded++;
    run.jobsObserved += result.jobs.length;
    for (const w of result.warnings) run.warnings.push(`${label}: ${w}`);

    const { tagsByExternalId, clusterByExternalId } = analyzeBoard(result.jobs);
    succeeded.push({
      seed,
      result,
      clusters: clusterByExternalId,
      tags: tagsByExternalId,
    });

    if (dryRun) {
      console.log(
        `  DRY   ${label.padEnd(32)} ${String(result.jobs.length).padStart(4)}건 조회`,
      );
      continue;
    }

    // 빈 응답은 슬러그 오류일 수 있다. 전체 충원으로 오판하면 되돌릴 수 없으므로
    // 반영하지 않고 경고만 남긴다.
    if (result.jobs.length === 0) {
      run.warnings.push(
        `${label}: 공고 0건 — 슬러그 오류 가능성. 충원 판정을 보류함`,
      );
      console.log(`  HOLD  ${label.padEnd(32)} 공고 0건 — 충원 판정 보류`);
      continue;
    }

    const diff = await store.applyBoardScan({
      atsProvider: seed.atsProvider as AtsProvider,
      companySlug: seed.slug,
      jobs: result.jobs,
      tagsByExternalId,
      observedAt: result.fetchedAt,
    });

    run.jobsNew += diff.newJobs;
    run.jobsClosed += diff.closed;
    run.jobsReopened += diff.reopened;
    run.jobsMissing += diff.missing;
    run.jobsRecovered += diff.recovered;

    console.log(
      `  OK    ${label.padEnd(32)} ` +
        `${String(result.jobs.length).padStart(4)}건 | ` +
        `신규 ${String(diff.newJobs).padStart(4)} ` +
        `유지 ${String(diff.stillOpen).padStart(4)} ` +
        `유예 ${String(diff.missing).padStart(3)} ` +
        `충원 ${String(diff.closed).padStart(3)} ` +
        `복귀 ${String(diff.recovered).padStart(2)} ` +
        `재오픈 ${String(diff.reopened).padStart(2)} ` +
        `재게시 ${String(diff.reposts).padStart(2)}`,
    );
  }

  run.finishedAt = new Date().toISOString();

  if (!dryRun) {
    await store.flush();
    await store.recordRun(run);
  }

  const elapsed = (
    (new Date(run.finishedAt).getTime() - startedAt.getTime()) / 1000
  ).toFixed(1);

  console.log(
    `\n스캔 완료: 보드 ${run.boardsSucceeded}/${run.boardsAttempted} | ` +
      `공고 ${run.jobsObserved}건 | 신규 ${run.jobsNew} | 유예 ${run.jobsMissing} | ` +
      `충원 ${run.jobsClosed} | 복귀 ${run.jobsRecovered} | 재오픈 ${run.jobsReopened} | ${elapsed}s`,
  );

  // 깜빡임 경고: 복귀가 충원보다 많으면 ATS 응답이 불안정하다는 뜻이다.
  // 유예 로직이 오염을 막아주고 있지만, 지속되면 유예 시간을 늘려야 한다.
  if (run.jobsRecovered > 0 && run.jobsRecovered >= run.jobsClosed) {
    console.log(
      `  ! 복귀(${run.jobsRecovered}) >= 충원(${run.jobsClosed}) — ATS 응답 깜빡임 의심. ` +
        `유예 로직이 오염을 차단했습니다.`,
    );
  }

  if (run.failures.length > 0) {
    console.log(`\n실패 ${run.failures.length}건:`);
    for (const f of run.failures) console.log(`  - ${f.board}: ${f.message}`);
  }
  if (run.warnings.length > 0) {
    console.log(`\n경고 ${run.warnings.length}건:`);
    for (const w of run.warnings.slice(0, 10)) console.log(`  - ${w}`);
    if (run.warnings.length > 10) {
      console.log(`  ... 외 ${run.warnings.length - 10}건`);
    }
  }

  // --export는 --report와 독립적으로 동작해야 한다. CI에서는 콘솔 출력 없이
  // 산출물만 필요한 경우가 있다.
  if ((withReport || exportLeads) && !dryRun) {
    // 아카이브 증거는 콜드스타트를 우회하는 핵심 입력이다. 없으면 없는 대로
    // 동작하지만(가중치 재분배), 있으면 첫날부터 관측 나이를 부트스트랩한다.
    const archive = new ArchiveCache(path.join(DATA_DIR, 'archive-cache.json'));
    await archive.load();
    const leads = buildLeads(store, succeeded, archive);
    if (withReport) printLeads(leads);
    if (exportLeads) await writeLeads(leads, run.runId);
  }

  // 스냅샷 시계가 시작된 날짜를 알려준다. 이게 런치 가능일을 결정한다.
  if (run.jobsNew > 0 && store.observationCount === run.jobsNew) {
    const launchDate = new Date(startedAt.getTime() + 60 * 86_400_000);
    console.log(
      `\n관측 시계 시작. 60일 신호가 성숙하는 시점: ${launchDate.toISOString().slice(0, 10)}\n` +
        `그때까지 이 스캔을 매일 1회 돌려야 합니다.`,
    );
  }
  console.log('');
}

interface Lead {
  rel: number;
  score: number;
  grade: string;
  signals: number;
  confidence: number;
  ageDays: number | null;
  ageFromArchive: boolean;
  company: string;
  board: string;
  title: string;
  jobUrl: string;
  workplaceType: string;
  locationRaw: string | null;
  /** 직군 분류. 수임 가능 직군만 리드가 된다. */
  roleCategory: string;
  tags: string[];
  /** 유저에게 보여줄 "왜 이 리드인가" */
  reasons: string[];
}

interface LeadBuildResult {
  leads: Lead[];
  /** 신호는 강했지만 수임 불가 직군이라 제외된 건수 */
  droppedByRole: number;
  /** 제외된 직군 분포. 필터가 과하게 걷어내는지 감시한다. */
  droppedByCategory: Record<string, number>;
  /**
   * 직군별 제외 샘플 제목.
   *
   * 이 필터는 정밀도를 위해 재현율을 희생한다. 수임 가능한 직무를 잘못 걷어내면
   * 리드가 조용히 사라지고 아무 신호도 남지 않는다. 그래서 무엇을 버렸는지
   * 산출물에 남겨 지속적으로 검증할 수 있게 한다. 특히 'other'는 규칙이 못 잡은
   * 제목들이므로 분류기 개선의 입력이 된다.
   */
  droppedSamples: Record<string, string[]>;
}

/** 직군별로 보관할 제외 샘플 최대 개수 */
const DROPPED_SAMPLE_LIMIT = 15;

/** 현재 스냅샷 + 아카이브 증거로 리드를 산출한다 */
function buildLeads(
  store: FileSnapshotStore,
  boards: Array<{
    seed: SeedCompany;
    result: FetchJobsResult;
    clusters: Map<string, number | null>;
    tags: Map<string, string[]>;
  }>,
  archive: ArchiveCache,
): LeadBuildResult {
  const now = new Date();
  const rows: Lead[] = [];
  let droppedByRole = 0;
  const droppedByCategory: Record<string, number> = {};
  const droppedSamples: Record<string, string[]> = {};

  for (const board of boards) {
    const provider = board.seed.atsProvider as AtsProvider;
    for (const job of board.result.jobs) {
      const keyStr = jobKeyString({
        atsProvider: provider,
        companySlug: board.seed.slug,
        externalId: job.externalId,
      });
      const obs = store.getObservation(keyStr);
      const observedAgeDays = obs
        ? computeAgeDays(new Date(obs.firstSeenAt), now)
        : null;
      const archiveAgeDays = archive.archiveAgeDays(job.jobUrl, now);

      const breakdown = scoreLead({
        title: job.title,
        companySlug: job.companySlug,
        reportedAgeDays: computeAgeDays(job.sourcePublishedAt, now),
        observedAgeDays,
        archiveAgeDays,
        repostCount: store.getRepostCount(
          provider,
          board.seed.slug,
          job.titleFingerprint,
        ),
        reopenCount: obs ? obs.reopenCount : null,
        companyGrowthRatio: null, // 30일 이력 필요
        clusterSize: board.clusters.get(job.externalId) ?? null,
        companyOpenJobs: board.result.jobs.length,
      });

      if (breakdown.grade === 'cold') continue;

      // 수임 가능성 게이트.
      //
      // 점수는 "얼마나 막혀 있는가"만 측정한다. 750일 막힌 Account Executive
      // 공고는 정확한 신호지만 프리랜서 개발자가 할 수 있는 일이 아니다.
      // 이런 리드를 보내면 유저는 아무것도 못 하고 이탈한다 — 재현율보다
      // 정밀도가 중요한 지점이다.
      const role = classifyRole(job.title, job.department);
      if (!role.addressable) {
        droppedByRole++;
        droppedByCategory[role.category] =
          (droppedByCategory[role.category] ?? 0) + 1;
        const samples = (droppedSamples[role.category] ??= []);
        if (samples.length < DROPPED_SAMPLE_LIMIT) samples.push(job.title);
        continue;
      }

      const effectiveAge = Math.max(observedAgeDays ?? 0, archiveAgeDays ?? 0);
      rows.push({
        rel: breakdown.relativeScore,
        score: breakdown.score,
        grade: breakdown.grade,
        signals: breakdown.contributingSignals,
        confidence: breakdown.confidence,
        ageDays: effectiveAge > 0 ? effectiveAge : null,
        ageFromArchive:
          archiveAgeDays !== null && archiveAgeDays >= (observedAgeDays ?? 0),
        company: board.seed.displayName ?? board.seed.slug,
        board: `${provider}:${board.seed.slug}`,
        title: job.title,
        jobUrl: job.jobUrl,
        workplaceType: job.workplaceType,
        locationRaw: job.locationRaw,
        roleCategory: role.category,
        tags: (board.tags.get(job.externalId) ?? []).slice(0, 6),
        reasons: breakdown.reasons,
      });
    }
  }

  rows.sort((a, b) => b.rel - a.rel || b.score - a.score);
  return { leads: rows, droppedByRole, droppedByCategory, droppedSamples };
}

function printLeads(result: LeadBuildResult): void {
  const { leads: rows, droppedByRole, droppedByCategory } = result;
  const hot = rows.filter((r) => r.grade === 'hot').length;

  const dropped = Object.entries(droppedByCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => `${cat} ${n}`)
    .join(', ');

  console.log(
    `\n리드 현황: hot ${hot} / warm ${rows.length - hot} (cold 제외)\n` +
      `  수임 불가 직군 제외 ${droppedByRole}건${dropped ? ` — ${dropped}` : ''}\n` +
      `  나이 뒤 * 는 Wayback 아카이브가 증명한 값입니다.\n` +
      `  rel  점수 신호 신뢰   나이  직군      회사            제목`,
  );
  for (const r of rows.slice(0, 16)) {
    const tags = r.tags.length ? ` [${r.tags.slice(0, 4).join(', ')}]` : '';
    const age = r.ageDays === null ? '-' : `${r.ageDays}${r.ageFromArchive ? '*' : ''}`;
    console.log(
      `  ${r.rel.toFixed(2)} ${String(r.score).padStart(3)}점 ${r.signals}개 ` +
        `${String(Math.round(r.confidence * 100)).padStart(3)}% ` +
        `${age.padStart(6)}  ${r.roleCategory.padEnd(9)} ` +
        `${r.company.slice(0, 14).padEnd(14)} ${r.title.slice(0, 38).padEnd(38)}${tags}`,
    );
  }
}

/**
 * 리드를 파일로 내보낸다.
 *
 * 왜 필요한가: 지금은 리드가 콘솔에만 존재한다. 유저에게 전달할 수 있는 형태가
 * 없으면 제품이 아니다. 이 JSON이 이후 이메일 다이제스트·웹 대시보드·API의
 * 단일 소스가 된다.
 *
 * 공고 본문은 저장하지 않는다. ATS의 job board API는 자사 채용 페이지 구축을
 * 목적으로 제공된 것이므로 본문을 재배포하지 않고 원문 링크로 보내는 것이 맞다.
 * 우리가 파는 것은 본문이 아니라 "어느 공고가 왜 기회인가"라는 판단이다.
 */
async function writeLeads(
  result: LeadBuildResult,
  runId: string,
): Promise<void> {
  const rows = result.leads;
  const hot = rows.filter((r) => r.grade === 'hot');
  const byRole: Record<string, number> = {};
  for (const r of rows) byRole[r.roleCategory] = (byRole[r.roleCategory] ?? 0) + 1;

  const payload = {
    generatedAt: new Date().toISOString(),
    runId,
    summary: {
      total: rows.length,
      hot: hot.length,
      warm: rows.length - hot.length,
      withArchiveEvidence: rows.filter((r) => r.ageFromArchive).length,
      byRole,
      droppedByRole: result.droppedByRole,
      droppedByCategory: result.droppedByCategory,
      droppedSamples: result.droppedSamples,
    },
    // 상위 500건만 내보낸다. 그 아래는 신호 강도가 낮아 실용 가치가 없고
    // 파일이 커지면 git 히스토리가 무거워진다.
    leads: rows.slice(0, 500),
  };

  const outPath = path.join(DATA_DIR, 'leads.json');
  const tmp = `${outPath}.tmp`;
  await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  await rename(tmp, outPath);

  console.log(
    `data/leads.json 기록: ${payload.leads.length}건 ` +
      `(hot ${hot.length} / 아카이브 증거 ${payload.summary.withArchiveEvidence})`,
  );
}

main().catch((err) => {
  console.error('\n치명적 오류:', err);
  process.exit(1);
});
