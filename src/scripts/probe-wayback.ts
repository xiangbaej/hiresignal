/**
 * 가설 A 결정 검증: Wayback CDX로 개별 공고의 과거 존재를 증명할 수 있는가?
 *
 * 성립하면 콜드스타트가 해소된다. 지금 열려 있는 공고가 200일 전 아카이브에
 * 잡혀 있다면 "이 공고는 최소 200일간 열려 있었다"는 독립적 증거가 되고,
 * 우리가 60일을 기다릴 필요가 없다.
 *
 * 성립 조건 두 가지를 모두 확인해야 한다:
 *   1. 커버리지 — 현재 공고 URL 중 아카이브에 존재하는 비율이 유의미한가
 *   2. 시간 깊이 — 최초 캡처가 충분히 과거인가 (60일+)
 *
 * 커버리지가 낮으면(예: 5%) 신호를 소수 공고에만 붙일 수 있어 제품이 안 된다.
 *
 * 이 스크립트는 data/state.json의 기존 스냅샷을 재사용한다 (재수집 없음).
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { fetchJson, mapWithConcurrency } from '../lib/ats/http.js';
import type { JobObservation } from '../lib/store/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MS_PER_DAY = 86_400_000;

interface CdxResult {
  captures: number;
  oldestStamp: string | null;
  newestStamp: string | null;
  error: string | null;
}

/**
 * 단일 URL의 아카이브 캡처 이력을 조회한다.
 *
 * `matchType=exact`로 정확히 그 공고만 본다. 와일드카드를 쓰면 보드 전체가
 * 잡혀서 "이 공고가 존재했다"는 증거가 되지 못한다 — 앞선 탐색의 한계였다.
 */
async function probeUrl(jobUrl: string): Promise<CdxResult> {
  // CDX는 스킴을 무시하지만 쿼리스트링은 구분한다. 정규화해서 조회한다.
  const normalized = jobUrl.replace(/^https?:\/\//, '');
  const api =
    `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(normalized)}` +
    `&output=json&matchType=exact&fl=timestamp&limit=500`;

  try {
    const rows = await fetchJson<string[][]>(api, {
      retries: 2,
      timeoutMs: 30_000,
    });
    const data = rows.slice(1); // 헤더 제거
    if (data.length === 0) {
      return { captures: 0, oldestStamp: null, newestStamp: null, error: null };
    }
    const stamps = data
      .map((r) => r[0])
      .filter((s): s is string => typeof s === 'string')
      .sort();
    return {
      captures: stamps.length,
      oldestStamp: stamps[0] ?? null,
      newestStamp: stamps[stamps.length - 1] ?? null,
      error: null,
    };
  } catch (err) {
    return {
      captures: -1,
      oldestStamp: null,
      newestStamp: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** CDX 타임스탬프(YYYYMMDDhhmmss) → Date */
function stampToDate(stamp: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(stamp);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
}

async function main() {
  const sampleSize = Number(process.argv[2] ?? 60);

  const raw = await readFile(path.join(ROOT, 'data/state.json'), 'utf8');
  const state = JSON.parse(raw) as { observations: JobObservation[] };
  const all = state.observations.filter((o) => o.closedAt === null);

  if (all.length === 0) {
    console.error('스냅샷이 비어 있습니다. 먼저 npm run scan 을 실행하세요.');
    process.exit(1);
  }

  // 보드별로 균등 표집한다. 한 보드에 몰리면 커버리지 추정이 왜곡된다.
  const byBoard = new Map<string, JobObservation[]>();
  for (const o of all) {
    const key = `${o.key.atsProvider}:${o.key.companySlug}`;
    const list = byBoard.get(key) ?? [];
    list.push(o);
    byBoard.set(key, list);
  }

  const perBoard = Math.max(1, Math.floor(sampleSize / byBoard.size));
  const sample: JobObservation[] = [];
  for (const list of byBoard.values()) {
    sample.push(...list.slice(0, perBoard));
  }

  console.log(
    `\nWayback CDX 개별 공고 검증\n` +
      `표본 ${sample.length}건 / 전체 열린 공고 ${all.length}건 / 보드 ${byBoard.size}개\n` +
      `matchType=exact — 해당 공고 URL만 조회합니다.\n`,
  );

  const now = Date.now();
  // archive.org는 공격적 병렬 호출에 429를 준다. 낮게 유지한다.
  const results = await mapWithConcurrency(sample, 3, async (obs) => ({
    obs,
    cdx: await probeUrl(obs.jobUrl),
  }));

  let archived = 0;
  let notArchived = 0;
  let errors = 0;
  const ages: number[] = [];
  const rows: Array<{
    board: string;
    title: string;
    reportedAge: number | null;
    archiveAge: number | null;
    captures: number;
  }> = [];

  for (const r of results) {
    if (!r.ok) {
      errors++;
      continue;
    }
    const { obs, cdx } = r.value;
    if (cdx.captures < 0) {
      errors++;
      continue;
    }

    const reportedAge = obs.sourcePublishedAt
      ? Math.floor((now - new Date(obs.sourcePublishedAt).getTime()) / MS_PER_DAY)
      : null;

    if (cdx.captures === 0) {
      notArchived++;
      rows.push({
        board: `${obs.key.atsProvider}:${obs.key.companySlug}`,
        title: obs.title,
        reportedAge,
        archiveAge: null,
        captures: 0,
      });
      continue;
    }

    archived++;
    const oldest = cdx.oldestStamp ? stampToDate(cdx.oldestStamp) : null;
    const archiveAge = oldest
      ? Math.floor((now - oldest.getTime()) / MS_PER_DAY)
      : null;
    if (archiveAge !== null) ages.push(archiveAge);

    rows.push({
      board: `${obs.key.atsProvider}:${obs.key.companySlug}`,
      title: obs.title,
      reportedAge,
      archiveAge,
      captures: cdx.captures,
    });
  }

  const tested = archived + notArchived;
  const coverage = tested > 0 ? (archived / tested) * 100 : 0;

  console.log('=== 커버리지 ===');
  console.log(`아카이브 존재: ${archived}건`);
  console.log(`아카이브 없음: ${notArchived}건`);
  console.log(`조회 오류:     ${errors}건`);
  console.log(`커버리지:      ${coverage.toFixed(1)}%`);

  if (ages.length > 0) {
    ages.sort((a, b) => a - b);
    const median = ages[Math.floor(ages.length / 2)] as number;
    const over60 = ages.filter((a) => a >= 60).length;
    console.log('\n=== 시간 깊이 (최초 캡처 기준 경과일) ===');
    console.log(`최소 ${ages[0]}일 / 중앙값 ${median}일 / 최대 ${ages[ages.length - 1]}일`);
    console.log(
      `60일 이상 아카이브: ${over60}/${ages.length}건 ` +
        `(표본 전체의 ${((over60 / tested) * 100).toFixed(1)}%)`,
    );
  }

  console.log('\n=== 샘플 (아카이브 있는 것 우선) ===');
  console.log('  보드                     ATS게시  아카이브  캡처  제목');
  const sorted = rows
    .slice()
    .sort((a, b) => (b.archiveAge ?? -1) - (a.archiveAge ?? -1));
  for (const r of sorted.slice(0, 20)) {
    console.log(
      `  ${r.board.padEnd(24)} ${String(r.reportedAge ?? '-').padStart(5)}일 ` +
        `${String(r.archiveAge ?? '없음').padStart(7)}${r.archiveAge !== null ? '일' : '  '} ` +
        `${String(r.captures).padStart(4)}  ${r.title.slice(0, 40)}`,
    );
  }
  console.log('');
}

main().catch((e) => {
  console.error('오류:', e);
  process.exit(1);
});
