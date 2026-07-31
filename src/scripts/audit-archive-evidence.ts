/**
 * 아카이브 증거의 건전성 감사.
 *
 *   npx tsx src/scripts/audit-archive-evidence.ts [표본수]
 *
 * ── 무엇을 의심하는가 ──
 *
 * enrich-archive.ts는 CDX에서 `timestamp`만 가져와 최초 캡처 시각을 공고 나이의
 * 하한으로 썼다. 그런데 검증하지 않은 가정이 하나 있다:
 *
 *   "캡처가 존재한다 == 그 시점에 공고가 존재했다"
 *
 * 이건 참이 아닐 수 있다. Wayback은 404·410·301 응답도 캡처한다. 크롤러가
 * 존재하지 않는 URL을 방문했다면 "404 페이지의 스냅샷"이 남는다. 그 캡처를
 * 근거로 "이 공고는 750일 전에 있었다"고 말하면 거짓이다.
 *
 * 이 가정 위에 콜드스타트 해법 전체가 서 있으므로, 무엇보다 먼저 검증해야 한다.
 * 리드가 유용한지 사람에게 묻기 전에 리드가 사실인지 확인하는 것이 순서다.
 *
 * ── 검증 방법 ──
 *
 * 같은 URL을 `statuscode`까지 포함해 다시 조회하고, 최초 캡처와 최초 **200**
 * 캡처를 비교한다. 둘이 크게 다르면 현재 나이 추정이 과대평가되어 있다는 뜻이다.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { fetchJson, mapWithConcurrency } from '../lib/ats/http.js';
import { ArchiveCache, stampToDate } from '../lib/store/archive-cache.js';
import type { JobObservation } from '../lib/store/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MS_PER_DAY = 86_400_000;

interface Capture {
  timestamp: string;
  statuscode: string;
  mimetype: string;
  digest: string;
}

async function probeDetailed(jobUrl: string): Promise<Capture[] | null> {
  const normalized = jobUrl.replace(/^https?:\/\//, '');
  const api =
    `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(normalized)}` +
    `&output=json&matchType=exact&limit=500` +
    `&fl=timestamp,statuscode,mimetype,digest`;

  try {
    const rows = await fetchJson<string[][]>(api, { retries: 2, timeoutMs: 30_000 });
    return rows
      .slice(1)
      .map((r) => ({
        timestamp: r[0] ?? '',
        statuscode: r[1] ?? '',
        mimetype: r[2] ?? '',
        digest: r[3] ?? '',
      }))
      .filter((c) => c.timestamp)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch {
    return null;
  }
}

const ageOf = (stamp: string, now: number): number | null => {
  const d = stampToDate(stamp);
  return d ? Math.floor((now - d.getTime()) / MS_PER_DAY) : null;
};

async function main() {
  const sampleSize = Number(process.argv[2] ?? 40);

  const state = JSON.parse(
    await readFile(path.join(ROOT, 'data/state.json'), 'utf8'),
  ) as { observations: JobObservation[] };

  const cache = new ArchiveCache(path.join(ROOT, 'data/archive-cache.json'));
  await cache.load();

  const now = Date.now();

  // 증거가 있다고 판단한 공고 중 나이가 큰 순으로 표집한다.
  // 문제가 있다면 여기서 가장 크게 드러난다 — 나이가 클수록 리드 상위에 오고,
  // 상위 리드가 거짓이면 제품 신뢰가 무너진다.
  const candidates = state.observations
    .filter((o) => o.closedAt === null)
    .map((o) => ({ obs: o, archiveAge: cache.archiveAgeDays(o.jobUrl, new Date(now)) }))
    .filter((x): x is { obs: JobObservation; archiveAge: number } => x.archiveAge !== null)
    .sort((a, b) => b.archiveAge - a.archiveAge)
    .slice(0, sampleSize);

  console.log(
    `\n아카이브 증거 감사 — 표본 ${candidates.length}건 (나이 상위)\n` +
      `검증: "캡처 존재 == 공고 존재" 가정이 참인가\n`,
  );

  const results = await mapWithConcurrency(candidates, 3, async (c) => ({
    ...c,
    captures: await probeDetailed(c.obs.jobUrl),
  }));

  let sound = 0;
  let inflated = 0;
  let noSuccessCapture = 0;
  let failed = 0;
  const inflations: number[] = [];
  const rows: string[] = [];

  for (const r of results) {
    if (!r.ok || r.value.captures === null) {
      failed++;
      continue;
    }
    const { obs, archiveAge, captures } = r.value;

    const first = captures[0];
    // 200뿐 아니라 3xx도 "존재"의 증거로 볼 수 있다 — 공고가 다른 URL로
    // 이동한 경우다. 하지만 4xx/5xx는 존재하지 않았다는 증거에 가깝다.
    const firstOk = captures.find(
      (c) => c.statuscode.startsWith('2') || c.statuscode.startsWith('3'),
    );

    if (!first) {
      failed++;
      continue;
    }

    if (!firstOk) {
      noSuccessCapture++;
      rows.push(
        `  ✗ 성공캡처없음  주장 ${String(archiveAge).padStart(5)}일  ` +
          `상태 ${captures.map((c) => c.statuscode).slice(0, 5).join(',')}  ` +
          obs.title.slice(0, 40),
      );
      continue;
    }

    const claimedAge = ageOf(first.timestamp, now);
    const trueAge = ageOf(firstOk.timestamp, now);
    if (claimedAge === null || trueAge === null) {
      failed++;
      continue;
    }

    const gap = claimedAge - trueAge;
    if (gap <= 7) {
      sound++;
    } else {
      inflated++;
      inflations.push(gap);
      rows.push(
        `  △ 과대평가 ${String(gap).padStart(5)}일  ` +
          `주장 ${String(claimedAge).padStart(5)}일 → 실제 ${String(trueAge).padStart(5)}일  ` +
          `(최초상태 ${first.statuscode})  ${obs.title.slice(0, 34)}`,
      );
    }
  }

  const tested = sound + inflated + noSuccessCapture;

  console.log('=== 결과 ===');
  console.log(`건전 (오차 7일 이내):     ${sound}건`);
  console.log(`과대평가 (7일 초과):      ${inflated}건`);
  console.log(`성공 캡처 전무 (증거 무효): ${noSuccessCapture}건`);
  console.log(`조회 실패:                ${failed}건`);
  if (tested > 0) {
    const bad = inflated + noSuccessCapture;
    console.log(
      `\n증거 건전성: ${Math.round((sound / tested) * 100)}% ` +
        `(문제 ${bad}/${tested}건, ${Math.round((bad / tested) * 100)}%)`,
    );
  }
  if (inflations.length > 0) {
    inflations.sort((a, b) => a - b);
    console.log(
      `과대평가 폭: 최소 ${inflations[0]}일 / 중앙값 ${inflations[Math.floor(inflations.length / 2)]}일 / 최대 ${inflations[inflations.length - 1]}일`,
    );
  }

  if (rows.length > 0) {
    console.log('\n=== 문제 사례 ===');
    for (const row of rows.slice(0, 20)) console.log(row);
    if (rows.length > 20) console.log(`  ... 외 ${rows.length - 20}건`);
  } else {
    console.log('\n문제 사례 없음 — 모든 표본에서 최초 캡처가 성공 응답이었습니다.');
  }

  console.log(
    `\n판정 기준: 문제 비율이 10%를 넘으면 enrich-archive.ts가 statuscode를\n` +
      `필터링하도록 고쳐야 하고, 기존 캐시를 무효화해 재수집해야 합니다.\n`,
  );
}

main().catch((e) => {
  console.error('오류:', e);
  process.exit(1);
});
