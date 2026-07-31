/**
 * Wayback CDX 보강 — 콜드스타트 해소 파이프라인.
 *
 *   npx tsx src/pipeline/enrich-archive.ts             # 기본 300건 백필
 *   npx tsx src/pipeline/enrich-archive.ts --limit 800 # 상한 조정
 *   npx tsx src/pipeline/enrich-archive.ts --stats     # 조회 없이 현황만
 *
 * ── 무엇을 해결하는가 ──
 *
 * 이 제품의 핵심 신호는 "이 공고가 얼마나 오래 안 채워지고 있는가"인데, ATS가 주는
 * 게시일은 requisition 재사용으로 오염되어 있고 우리 관측은 60일이 필요하다.
 * Wayback Machine은 제3자가 남긴 독립적 기록이라 이 문제를 우회한다. 특정 공고
 * URL이 300일 전 캡처에 있으면 그 시점에 존재했다는 것은 반증 불가능하다.
 *
 * 실측(표본 44건): 커버리지 56.8%, 최초 캡처 경과일 중앙값 365일,
 * 60일 이상 아카이브 확보가 표본 전체의 43.2%.
 *
 * ── 예상하지 못한 부수 효과 ──
 *
 * 아카이브 나이가 ATS 게시일보다 오래된 사례가 나왔다(ashby:ramp 113일 vs 1006일).
 * 같은 URL이 1006일 전 아카이브에 있는데 ATS는 113일 전 게시라고 말한다면, ATS가
 * 게시일을 리셋한 것이다. 이 불일치 자체가 requisition 재활용의 증거가 된다.
 *
 * ── archive.org 예절 ──
 *
 * 동시성 3, 실행당 조회 상한을 둔다. 캐시가 있으므로 며칠에 걸쳐 백필하면 된다.
 * 급하게 다 긁을 이유가 없다.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { fetchJson, mapWithConcurrency } from '../lib/ats/http.js';
import { ArchiveCache } from '../lib/store/archive-cache.js';
import type { JobObservation } from '../lib/store/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const STATE_PATH = path.join(ROOT, 'data/state.json');
const CACHE_PATH = path.join(ROOT, 'data/archive-cache.json');

/** archive.org에 대한 동시 요청 수. 낮게 유지한다. */
const CONCURRENCY = 3;
/** 실행당 기본 조회 상한 */
const DEFAULT_LIMIT = 300;
/** 이 건수마다 캐시를 저장한다. 중단 시 진행분 유실을 막는다. */
const CHUNK_SIZE = 50;
/**
 * 실행당 시간 예산.
 *
 * 실측: archive.org 응답이 건당 약 1초라 2,000건 백필에 30분 이상 걸린다.
 * CI 러너 타임아웃(30분)에 걸리면 커밋 단계가 실행되지 않으므로, 그보다 먼저
 * 자발적으로 멈추고 다음 실행이 이어받게 한다.
 */
const TIME_BUDGET_MS = 12 * 60 * 1000;

interface CdxProbe {
  captures: number;
  oldestStamp: string | null;
}

/**
 * 단일 URL의 캡처 이력 조회.
 *
 * `matchType=exact`가 핵심이다. 와일드카드를 쓰면 보드 전체가 잡혀서
 * "이 공고가 그때 존재했다"는 증거가 되지 못한다.
 */
async function probeUrl(jobUrl: string): Promise<CdxProbe | null> {
  const normalized = jobUrl.replace(/^https?:\/\//, '');
  // statuscode를 함께 가져오는 것이 중요하다.
  //
  // Wayback은 404·410 응답도 캡처한다. 크롤러가 존재하지 않는 URL을 방문했다면
  // "404 페이지의 스냅샷"이 남고, 그것을 근거로 "이 공고는 750일 전에 있었다"고
  // 말하면 거짓이 된다. 성공(2xx) 또는 리다이렉트(3xx — 공고 URL 이동)만
  // 존재의 증거로 인정한다.
  //
  // audit-archive-evidence.ts로 기존 데이터 40건(나이 상위 = 가장 위험한 구간)을
  // 검증한 결과 100% 건전했지만, 표본이 깨끗한 것과 코드가 안전한 것은 다르다.
  const api =
    `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(normalized)}` +
    `&output=json&matchType=exact&fl=timestamp,statuscode&limit=500`;

  try {
    const rows = await fetchJson<string[][]>(api, {
      retries: 2,
      timeoutMs: 30_000,
    });
    const stamps = rows
      .slice(1) // 헤더 제거
      .filter((r) => {
        const status = r[1] ?? '';
        // 상태코드가 비어 있는 레코드도 존재한다. 보수적으로 제외한다.
        return status.startsWith('2') || status.startsWith('3');
      })
      .map((r) => r[0])
      .filter((s): s is string => typeof s === 'string')
      .sort();

    return {
      captures: stamps.length,
      oldestStamp: stamps[0] ?? null,
    };
  } catch {
    // 조회 실패는 캐시에 기록하지 않는다. "캡처 없음"으로 굳어지면
    // NEGATIVE_RECHECK_DAYS 동안 재시도하지 않아 증거를 놓친다.
    return null;
  }
}

const MS_PER_DAY = 86_400_000;

async function main() {
  const argv = process.argv.slice(2);
  const statsOnly = argv.includes('--stats');
  const limitIdx = argv.indexOf('--limit');
  const limit =
    limitIdx >= 0 ? Number(argv[limitIdx + 1] ?? DEFAULT_LIMIT) : DEFAULT_LIMIT;

  const state = JSON.parse(await readFile(STATE_PATH, 'utf8')) as {
    observations: JobObservation[];
  };
  const open = state.observations.filter((o) => o.closedAt === null);

  const cache = new ArchiveCache(CACHE_PATH);
  await cache.load();

  const now = new Date();
  const pending = open.filter((o) => cache.needsProbe(o.jobUrl, now));

  console.log(
    `\nWayback 아카이브 보강\n` +
      `열린 공고 ${open.length}건 | 캐시 ${cache.size}건 (증거 확보 ${cache.positiveCount}건)\n` +
      `조회 필요 ${pending.length}건`,
  );

  if (statsOnly) {
    reportStats(open, cache, now);
    return;
  }

  if (pending.length === 0) {
    console.log('\n백필 완료 — 조회할 항목이 없습니다.');
    reportStats(open, cache, now);
    return;
  }

  const batch = pending.slice(0, limit);
  console.log(
    `이번 실행에서 최대 ${batch.length}건 조회 (동시성 ${CONCURRENCY}, ` +
      `${CHUNK_SIZE}건마다 저장)\n` +
      `남은 백필: ${pending.length - batch.length}건\n`,
  );

  const startedAt = Date.now();
  let probed = 0;
  let found = 0;
  let failed = 0;

  // 청크 단위로 저장한다.
  //
  // 실측: archive.org 응답이 건당 1초 가까이 걸려 1,749건 백필이 28분을 넘겼고
  // 마지막에 한 번만 flush하는 구조에서는 중단 시 진행분이 전부 유실됐다.
  // 이제 청크마다 저장하므로 언제 중단해도 다음 실행이 이어받는다.
  for (let offset = 0; offset < batch.length; offset += CHUNK_SIZE) {
    const chunk = batch.slice(offset, offset + CHUNK_SIZE);

    const results = await mapWithConcurrency(chunk, CONCURRENCY, async (obs) => ({
      obs,
      probe: await probeUrl(obs.jobUrl),
    }));

    for (const r of results) {
      if (!r.ok) {
        failed++;
        continue;
      }
      const { obs, probe } = r.value;
      if (probe === null) {
        failed++;
        continue;
      }
      cache.set(obs.jobUrl, {
        probedAt: new Date().toISOString(),
        captures: probe.captures,
        oldestStamp: probe.oldestStamp,
      });
      probed++;
      if (probe.captures > 0) found++;
    }

    await cache.flush();

    const done = Math.min(offset + CHUNK_SIZE, batch.length);
    const rate = (Date.now() - startedAt) / 1000 / Math.max(probed, 1);
    console.log(
      `  진행 ${String(done).padStart(5)}/${batch.length} | ` +
        `증거 ${String(found).padStart(4)} | 실패 ${failed} | ` +
        `건당 ${rate.toFixed(2)}s | 저장 완료`,
    );

    // 시간 예산 초과 시 자발적으로 중단한다. 캐시는 이미 저장됐으므로
    // 다음 실행이 남은 분량을 이어받는다. CI 러너 타임아웃보다 먼저 멈춘다.
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      console.log(
        `\n시간 예산 ${TIME_BUDGET_MS / 60000}분 도달 — 중단합니다. ` +
          `다음 실행이 남은 ${batch.length - done}건을 이어받습니다.`,
      );
      break;
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `\n조회 완료: ${probed}건 기록 | 증거 확보 ${found}건 ` +
      `(${probed ? Math.round((found / probed) * 100) : 0}%) | 실패 ${failed}건 | ${elapsed}s`,
  );

  reportStats(open, cache, now);
}

function reportStats(
  open: JobObservation[],
  cache: ArchiveCache,
  now: Date,
): void {
  let withEvidence = 0;
  let over60 = 0;
  let dateReset = 0;
  const ages: number[] = [];
  const resetSamples: Array<{
    title: string;
    reported: number;
    archive: number;
  }> = [];

  for (const obs of open) {
    const archiveAge = cache.archiveAgeDays(obs.jobUrl, now);
    if (archiveAge === null) continue;

    withEvidence++;
    ages.push(archiveAge);
    if (archiveAge >= 60) over60++;

    const reportedAge = obs.sourcePublishedAt
      ? Math.floor(
          (now.getTime() - new Date(obs.sourcePublishedAt).getTime()) / MS_PER_DAY,
        )
      : null;

    // 아카이브가 ATS 게시일보다 60일 이상 오래됐다면 게시일이 리셋된 것이다.
    if (reportedAge !== null && archiveAge > reportedAge + 60) {
      dateReset++;
      if (resetSamples.length < 8) {
        resetSamples.push({
          title: obs.title,
          reported: reportedAge,
          archive: archiveAge,
        });
      }
    }
  }

  const pct = (n: number) =>
    open.length ? `${((n / open.length) * 100).toFixed(1)}%` : '-';

  console.log(`\n=== 신호 현황 (열린 공고 ${open.length}건 기준) ===`);
  console.log(`아카이브 증거 확보:     ${withEvidence}건 (${pct(withEvidence)})`);
  console.log(`60일 이상 증명:         ${over60}건 (${pct(over60)})`);
  console.log(`게시일 리셋 탐지:       ${dateReset}건 (${pct(dateReset)})`);

  if (ages.length > 0) {
    ages.sort((a, b) => a - b);
    console.log(
      `아카이브 나이: 최소 ${ages[0]}일 / 중앙값 ${ages[Math.floor(ages.length / 2)]}일 / 최대 ${ages[ages.length - 1]}일`,
    );
  }

  if (resetSamples.length > 0) {
    console.log('\n게시일 리셋 샘플 (ATS 게시일 < 아카이브 나이):');
    for (const s of resetSamples) {
      console.log(
        `  ATS ${String(s.reported).padStart(4)}일 vs 아카이브 ${String(s.archive).padStart(5)}일  ${s.title.slice(0, 46)}`,
      );
    }
  }
  console.log('');
}

main().catch((e) => {
  console.error('오류:', e);
  process.exit(1);
});
