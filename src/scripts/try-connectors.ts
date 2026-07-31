/**
 * DB 없이 커넥터 + 스코어링을 즉시 검증하는 스크립트.
 *
 *   npx tsx src/scripts/try-connectors.ts                    # 시드 전체
 *   npx tsx src/scripts/try-connectors.ts greenhouse         # 특정 provider
 *   npx tsx src/scripts/try-connectors.ts lever:shieldai     # 특정 회사
 *   npx tsx src/scripts/try-connectors.ts --content          # 본문 포함(스택 추출)
 *
 * 이 스크립트는 관측 이력이 없는 "첫날" 상태를 재현한다. 따라서:
 *  - Hot 등급은 나오지 않는다 (신뢰도 요건 미달) — 정상이다.
 *  - 정렬은 절대점수가 아니라 relativeScore로 한다.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { mapWithConcurrency } from '../lib/ats/http.js';
import { getConnector, isAtsProvider } from '../lib/ats/registry.js';
import { computeAgeDays, scoreLead } from '../lib/signals/score.js';
import {
  categorize,
  detectBoardWideTags,
  extractTechStack,
} from '../lib/signals/stack.js';
import {
  AtsFetchError,
  type AtsProvider,
  type NormalizedJob,
} from '../lib/ats/types.js';

interface SeedCompany {
  atsProvider: string;
  slug: string;
  displayName?: string;
  verifiedAt?: string;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function loadSeeds(): Promise<SeedCompany[]> {
  const file = await readFile(path.join(ROOT, 'seeds/companies.json'), 'utf8');
  const parsed = JSON.parse(file) as { companies: SeedCompany[] };
  return parsed.companies.filter((c) => isAtsProvider(c.atsProvider));
}

function matchesFilter(company: SeedCompany, filters: string[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((f) => {
    const [provider, slug] = f.split(':');
    if (slug) {
      return (
        company.atsProvider === provider &&
        company.slug.toLowerCase() === slug.toLowerCase()
      );
    }
    return company.atsProvider === provider;
  });
}

const pct = (n: number, total: number) =>
  total === 0 ? '0%' : `${Math.round((n / total) * 100)}%`;

/**
 * 공고별 스택 태그를 한 번만 계산해 재사용한다.
 * `companySlug`를 넘겨 자사명 유래 태그를 제외하는 것이 핵심이다.
 */
function computeTags(jobs: NormalizedJob[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const job of jobs) {
    map.set(
      job.externalId,
      extractTechStack(job.descriptionText, job.companySlug),
    );
  }
  return map;
}

/**
 * 클러스터 크기: 같은 보드에서 동일 스택 카테고리로 열린 공고 수.
 * 단일 스냅샷으로 계산 가능하므로 첫날부터 쓸 수 있는 유일한 신호다.
 *
 * 두 가지 오염을 걷어낸다:
 *  1. 보드 전역 태그 (회사 배경 설명에서 온 것) — detectBoardWideTags
 *  2. 부서명 폴백 — 부서 단위는 너무 거칠어서 "Engineering 300건" 같은
 *     무의미한 클러스터를 만든다. 스택을 못 뽑으면 클러스터를 포기(null)하는 것이
 *     가짜 신호를 만드는 것보다 낫다.
 */
function buildClusterMap(
  jobs: NormalizedJob[],
  tagsByJob: Map<string, string[]>,
): Map<string, number | null> {
  const boardWide = detectBoardWideTags(tagsByJob.values(), jobs.length);

  const keysOf = (job: NormalizedJob): string[] => {
    const tags = (tagsByJob.get(job.externalId) ?? []).filter(
      (t) => !boardWide.has(t),
    );
    if (tags.length === 0) return [];
    return [...categorize(tags).keys()].map(String);
  };

  const categoryCounts = new Map<string, number>();
  for (const job of jobs) {
    for (const key of new Set(keysOf(job))) {
      categoryCounts.set(key, (categoryCounts.get(key) ?? 0) + 1);
    }
  }

  const perJob = new Map<string, number | null>();
  for (const job of jobs) {
    const keys = keysOf(job);
    perJob.set(
      job.externalId,
      keys.length
        ? Math.max(...keys.map((k) => categoryCounts.get(k) ?? 1))
        : null,
    );
  }
  return perJob;
}

async function main() {
  const argv = process.argv.slice(2);
  const includeContent = argv.includes('--content');
  const filters = argv.filter((a) => !a.startsWith('--'));

  const seeds = (await loadSeeds()).filter((c) => matchesFilter(c, filters));
  if (seeds.length === 0) {
    console.error('필터에 맞는 시드가 없습니다.');
    process.exit(1);
  }

  console.log(
    `\nHireSignal 커넥터 검증 — ${seeds.length}개 보드` +
      `${includeContent ? ' (본문 포함)' : ''}\n` +
      `관측 이력 없는 첫날 상태. Hot 미출현이 정상이며 정렬은 relativeScore 기준입니다.\n`,
  );

  const startedAt = Date.now();
  const results = await mapWithConcurrency(
    seeds,
    Number(process.env.SCAN_CONCURRENCY ?? 6),
    async (seed) => ({
      seed,
      result: await getConnector(seed.atsProvider as AtsProvider).fetchJobs(
        seed.slug,
        { includeContent },
      ),
    }),
  );

  let totalJobs = 0;
  let totalEvergreen = 0;
  let totalMissingDate = 0;
  let failures = 0;
  const gradeCounts = { hot: 0, warm: 0, cold: 0 };
  const allWarnings: string[] = [];
  const samples: Array<{
    company: string;
    title: string;
    rel: number;
    score: number;
    grade: string;
    confidence: number;
    signals: number;
    reportedAge: number | null;
    stack: string[];
  }> = [];

  for (const [i, outcome] of results.entries()) {
    const seed = seeds[i] as SeedCompany;
    const label = `${seed.atsProvider}:${seed.slug}`;

    if (!outcome.ok) {
      failures++;
      const err = outcome.error;
      const detail =
        err instanceof AtsFetchError
          ? `${err.message}${err.status ? ` (HTTP ${err.status})` : ''}` +
            `${err.isPermanent ? ' [영구실패 — 시드 제거]' : ''}`
          : err instanceof Error
            ? err.message
            : String(err);
      console.log(`  FAIL  ${label.padEnd(32)} ${detail}`);
      continue;
    }

    const { result } = outcome.value;
    const jobs = result.jobs;
    totalJobs += jobs.length;

    const tagsByJob = computeTags(jobs);
    const clusters = buildClusterMap(jobs, tagsByJob);
    const boardGrades = { hot: 0, warm: 0, cold: 0 };
    let evergreenCount = 0;
    let missingDate = 0;

    for (const job of jobs) {
      const reportedAgeDays = computeAgeDays(
        job.sourcePublishedAt,
        result.fetchedAt,
      );
      if (reportedAgeDays === null) missingDate++;

      const breakdown = scoreLead({
        title: job.title,
        companySlug: job.companySlug,
        reportedAgeDays,
        // 첫 스캔이므로 이력 기반 신호는 전부 null
        observedAgeDays: null,
        archiveAgeDays: null,
        repostCount: null,
        reopenCount: null,
        companyGrowthRatio: null,
        clusterSize: clusters.get(job.externalId) ?? null,
        companyOpenJobs: jobs.length,
      });

      if (breakdown.evergreen.isEvergreen) evergreenCount++;
      boardGrades[breakdown.grade]++;
      gradeCounts[breakdown.grade]++;

      if (breakdown.grade !== 'cold') {
        samples.push({
          company: job.companyName ?? job.companySlug,
          title: job.title,
          rel: breakdown.relativeScore,
          score: breakdown.score,
          grade: breakdown.grade,
          confidence: breakdown.confidence,
          signals: breakdown.contributingSignals,
          reportedAge: reportedAgeDays,
          stack: (tagsByJob.get(job.externalId) ?? []).slice(0, 5),
        });
      }
    }

    totalEvergreen += evergreenCount;
    totalMissingDate += missingDate;

    console.log(
      `  OK    ${label.padEnd(32)} ` +
        `${String(jobs.length).padStart(4)}건 | ` +
        `warm ${String(boardGrades.warm).padStart(4)} ` +
        `cold ${String(boardGrades.cold).padStart(4)} | ` +
        `상시 ${String(evergreenCount).padStart(3)} (${pct(evergreenCount, jobs.length).padStart(4)}) | ` +
        `${String(result.durationMs).padStart(5)}ms`,
    );

    for (const w of result.warnings) allWarnings.push(`${label}: ${w}`);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  console.log(
    `\n요약: 보드 ${results.length - failures}/${results.length} 성공 | 공고 ${totalJobs}건\n` +
      `      등급  hot ${gradeCounts.hot} / warm ${gradeCounts.warm} (${pct(gradeCounts.warm, totalJobs)}) / cold ${gradeCounts.cold}\n` +
      `      상시 제외 ${totalEvergreen}건 (${pct(totalEvergreen, totalJobs)}) | ` +
      `게시일 결측 ${totalMissingDate}건 | ${elapsed}s`,
  );

  if (allWarnings.length > 0) {
    console.log(`\n경고 ${allWarnings.length}건:`);
    for (const w of allWarnings.slice(0, 12)) console.log(`  - ${w}`);
    if (allWarnings.length > 12) console.log(`  ... 외 ${allWarnings.length - 12}건`);
  }

  if (samples.length > 0) {
    samples.sort((a, b) => b.rel - a.rel || b.score - a.score);
    console.log(`\n상위 리드 후보 (warm 이상 ${samples.length}건 중 14건):`);
    console.log(`  rel   점수 신호 신뢰  게시일  회사            제목`);
    for (const s of samples.slice(0, 14)) {
      const stack = s.stack.length > 0 ? ` [${s.stack.join(', ')}]` : '';
      console.log(
        `  ${s.rel.toFixed(2)} ${String(s.score).padStart(4)}점 ` +
          `${String(s.signals)}개 ${String(Math.round(s.confidence * 100)).padStart(3)}% ` +
          `${String(s.reportedAge ?? '-').padStart(5)}일  ` +
          `${s.company.slice(0, 14).padEnd(14)} ${s.title.slice(0, 40).padEnd(40)}${stack}`,
      );
    }
  }

  console.log('');
  if (failures === results.length) process.exit(1);
}

main().catch((err) => {
  console.error('\n치명적 오류:', err);
  process.exit(1);
});
