/**
 * ATS 보드 발굴 및 검증.
 *
 *   npx tsx src/scripts/discover-boards.ts            # 후보 전체 프로브
 *   npx tsx src/scripts/discover-boards.ts --write    # 검증 결과를 시드에 반영
 *
 * ── 왜 필요한가 ──
 *
 * 슬러그는 추측할 수밖에 없고, 검증 없이 시드에 넣으면 파이프라인이 오염된다.
 * 특히 Lever와 SmartRecruiters는 **존재하지 않는 슬러그에도 HTTP 200 + 빈 배열**을
 * 반환한다. 404가 아니라서 오류로 잡히지 않고, 그대로 시드에 남으면 매일 "공고 0건"
 * 응답을 받는다. scan.ts가 이를 충원으로 오판하지는 않도록 만들었지만(HOLD 처리),
 * 애초에 시드에 없는 것이 맞다.
 *
 * ── 규모 필터가 신호 품질보다 중요한 이유 ──
 *
 * 실측: 대기업 보드 2,663건 중 'freelance' 표현이 단 1건이었다. Stripe·Databricks는
 * 프리랜서를 ATS로 뽑지 않고 벤더를 조달 프로세스로 선정한다. 리드가 아무리 정확해도
 * 발주가 불가능한 회사면 무가치하다. 따라서 공고 수를 회사 규모의 프록시로 써서
 * 지나치게 큰 보드를 제외한다.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { mapWithConcurrency } from '../lib/ats/http.js';
import { allConnectors } from '../lib/ats/registry.js';
import { isDemoBoard } from '../lib/signals/evergreen.js';
import { AtsFetchError, type AtsProvider } from '../lib/ats/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 공고 수 기반 규모 분류.
 *
 * 정확한 임직원 수는 알 수 없으므로 공개 공고 수를 프록시로 쓴다. 완벽하지 않지만
 * "발주 가능한 규모인가"를 가르는 데는 충분하다.
 *
 *  - micro(1~4):   너무 작다. 외주 예산 자체가 없을 수 있고 리드도 희박하다.
 *  - target(5~80): 시리즈 A~C 구간. 팀이 작아 한 자리를 못 채우면 실제로 외주를 쓴다.
 *  - large(81~150): 경계 구간. 포함하되 우선순위를 낮춘다.
 *  - enterprise(151+): 조달 프로세스가 있어 콜드메일이 통하지 않는다. 제외.
 */
type SizeBucket = 'micro' | 'target' | 'large' | 'enterprise';

function classifySize(jobCount: number): SizeBucket {
  if (jobCount <= 4) return 'micro';
  if (jobCount <= 80) return 'target';
  if (jobCount <= 150) return 'large';
  return 'enterprise';
}

interface ProbeHit {
  atsProvider: AtsProvider;
  slug: string;
  jobCount: number;
  size: SizeBucket;
  /** 게시일을 제공하는 공고 비율. 낮으면 staleness 신호가 약하다. */
  publishDateCoverage: number;
  sampleTitle: string | null;
}

interface CandidateResult {
  candidate: string;
  hits: ProbeHit[];
  /** 404/빈응답 등으로 어디에도 없었던 경우 */
  misses: number;
}

async function probeCandidate(candidate: string): Promise<CandidateResult> {
  const hits: ProbeHit[] = [];
  let misses = 0;

  // 4개 ATS를 순차로 찔러본다. 병렬로 하면 후보 수 x 4 만큼 동시 요청이 나가
  // 레이트리밋에 걸린다.
  for (const connector of allConnectors) {
    try {
      // 발굴 단계에서는 본문이 필요 없다. 페이로드를 줄여 빠르게 훑는다.
      const result = await connector.fetchJobs(candidate, {
        includeContent: false,
      });

      // 빈 배열은 "슬러그 없음"과 구별할 수 없다. 미스로 처리한다.
      if (result.jobs.length === 0) {
        misses++;
        continue;
      }

      const withDate = result.jobs.filter((j) => j.sourcePublishedAt).length;
      hits.push({
        atsProvider: connector.provider,
        slug: candidate,
        jobCount: result.jobs.length,
        size: classifySize(result.jobs.length),
        publishDateCoverage: withDate / result.jobs.length,
        sampleTitle: result.jobs[0]?.title ?? null,
      });
    } catch (err) {
      // 404는 정상적인 "이 ATS는 안 씀" 신호다. 그 외 오류만 구분할 가치가 있다.
      if (err instanceof AtsFetchError && err.isPermanent) {
        misses++;
      } else {
        misses++;
      }
    }
  }

  return { candidate, hits, misses };
}

interface SeedEntry {
  atsProvider: string;
  slug: string;
  displayName?: string;
  verifiedAt?: string;
  jobCount?: number;
  size?: SizeBucket;
}

async function main() {
  const write = process.argv.includes('--write');

  const raw = await readFile(path.join(ROOT, 'seeds/candidates.json'), 'utf8');
  const candidates = (JSON.parse(raw) as { candidates: string[] }).candidates
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c.length > 0 && !isDemoBoard(c));

  const unique = [...new Set(candidates)];

  console.log(
    `\nATS 보드 발굴 — 후보 ${unique.length}개 x ${allConnectors.length}개 ATS\n` +
      `빈 응답(200 [])은 미스로 처리합니다. Lever/SmartRecruiters의 오탐 방지입니다.\n`,
  );

  const startedAt = Date.now();
  // 후보 단위 동시성. 후보 하나가 내부에서 ATS 4개를 순차 호출하므로
  // 실제 동시 요청은 이 값과 같다.
  const outcomes = await mapWithConcurrency(unique, 6, probeCandidate);

  const allHits: ProbeHit[] = [];
  let notFound = 0;

  for (const outcome of outcomes) {
    if (!outcome.ok) continue;
    const { hits } = outcome.value;
    if (hits.length === 0) {
      notFound++;
      continue;
    }
    allHits.push(...hits);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  // --- 결과 요약 ---
  const byProvider = new Map<AtsProvider, ProbeHit[]>();
  const bySize = new Map<SizeBucket, ProbeHit[]>();
  for (const hit of allHits) {
    byProvider.set(hit.atsProvider, [...(byProvider.get(hit.atsProvider) ?? []), hit]);
    bySize.set(hit.size, [...(bySize.get(hit.size) ?? []), hit]);
  }

  console.log(`발굴 완료: ${allHits.length}개 보드 발견 / 미발견 후보 ${notFound}개 / ${elapsed}s\n`);

  console.log('ATS별:');
  for (const connector of allConnectors) {
    const list = byProvider.get(connector.provider) ?? [];
    console.log(`  ${connector.provider.padEnd(16)} ${String(list.length).padStart(3)}개`);
  }

  console.log('\n규모별 (공고 수 기준):');
  for (const bucket of ['micro', 'target', 'large', 'enterprise'] as SizeBucket[]) {
    const list = bySize.get(bucket) ?? [];
    console.log(`  ${bucket.padEnd(12)} ${String(list.length).padStart(3)}개`);
  }

  // 채택 대상: target + large. micro는 리드가 희박하고 enterprise는 전환이 안 된다.
  const eligible = allHits.filter(
    (h) => h.size === 'target' || h.size === 'large',
  );

  // --- 동일 슬러그 중복 제거 ---
  //
  // 한 회사가 두 ATS에 보드를 가진 경우가 있다(실측: clickhouse가 greenhouse와
  // ashby 양쪽에 166건). 둘 다 시드에 넣으면 같은 회사의 같은 공고를 두 번 관측해
  // 클러스터·재게시 신호가 부풀려진다. 공고 수가 많은 쪽을 채택한다 — 적은 쪽은
  // 보통 이전됐거나 방치된 보드다.
  const bySlug = new Map<string, ProbeHit[]>();
  for (const hit of eligible) {
    bySlug.set(hit.slug, [...(bySlug.get(hit.slug) ?? []), hit]);
  }

  const duplicates: string[] = [];
  const adopted: ProbeHit[] = [];
  for (const [slug, hits] of bySlug) {
    if (hits.length === 1) {
      adopted.push(hits[0] as ProbeHit);
      continue;
    }
    const sorted = [...hits].sort((a, b) => b.jobCount - a.jobCount);
    const winner = sorted[0] as ProbeHit;
    adopted.push(winner);
    duplicates.push(
      `${slug}: ${hits.map((h) => `${h.atsProvider}(${h.jobCount})`).join(' vs ')} ` +
        `→ ${winner.atsProvider} 채택`,
    );
  }

  adopted.sort(
    (a, b) =>
      a.atsProvider.localeCompare(b.atsProvider) || a.slug.localeCompare(b.slug),
  );

  if (duplicates.length > 0) {
    console.log(`\n동일 슬러그 중복 제거 ${duplicates.length}건:`);
    for (const d of duplicates) console.log(`  ${d}`);
  }

  console.log(
    `\n채택 대상 (target + large): ${adopted.length}개 보드, ` +
      `공고 ${adopted.reduce((s, h) => s + h.jobCount, 0)}건`,
  );
  console.log('  ATS              슬러그              공고  규모        게시일  샘플 제목');
  for (const h of adopted.slice(0, 40)) {
    console.log(
      `  ${h.atsProvider.padEnd(16)} ${h.slug.padEnd(18)} ` +
        `${String(h.jobCount).padStart(4)}  ${h.size.padEnd(10)} ` +
        `${String(Math.round(h.publishDateCoverage * 100)).padStart(4)}%  ` +
        `${(h.sampleTitle ?? '').slice(0, 34)}`,
    );
  }
  if (adopted.length > 40) console.log(`  ... 외 ${adopted.length - 40}개`);

  const excluded = allHits.filter((h) => h.size === 'enterprise');
  if (excluded.length > 0) {
    console.log(`\n제외 (enterprise, 151건 초과 — 조달 프로세스로 전환 불가):`);
    for (const h of excluded) {
      console.log(`  ${h.atsProvider}:${h.slug} (${h.jobCount}건)`);
    }
  }

  if (!write) {
    console.log('\n--write 를 붙이면 seeds/companies.json 에 반영합니다.\n');
    return;
  }

  // --- 시드 파일 갱신 (병합) ---
  //
  // 덮어쓰기가 아니라 병합이어야 한다. 이 프로브는 일시적 실패(레이트리밋, 타임아웃)로
  // 기존 보드를 놓칠 수 있고, 그렇게 빠진 보드는 scan.ts의 pruneBoards가 관측까지
  // 삭제한다. 관측 이력은 되돌릴 수 없는 자산이므로 프로브 한 번의 변덕으로 지워질 수
  // 없어야 한다.
  //
  // 제외는 명시적 근거가 있을 때만 한다: enterprise 규모로 커진 경우다.
  const today = new Date().toISOString().slice(0, 10);
  const merged = new Map<string, SeedEntry>();

  // 1) 기존 시드를 먼저 보존
  let preserved = 0;
  try {
    const existingRaw = await readFile(
      path.join(ROOT, 'seeds/companies.json'),
      'utf8',
    );
    const existing = JSON.parse(existingRaw) as { companies?: SeedEntry[] };
    for (const entry of existing.companies ?? []) {
      merged.set(`${entry.atsProvider}:${entry.slug}`, entry);
      preserved++;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  // 2) 이번 프로브 결과로 갱신/추가
  let added = 0;
  for (const h of adopted) {
    const key = `${h.atsProvider}:${h.slug}`;
    if (!merged.has(key)) added++;
    merged.set(key, {
      atsProvider: h.atsProvider,
      slug: h.slug,
      displayName: h.slug,
      verifiedAt: today,
      jobCount: h.jobCount,
      size: h.size,
    });
  }

  // 3) enterprise로 커진 보드만 명시적으로 제외
  const demoted: string[] = [];
  for (const h of allHits.filter((x) => x.size === 'enterprise')) {
    const key = `${h.atsProvider}:${h.slug}`;
    if (merged.delete(key)) {
      demoted.push(`${key} (${h.jobCount}건 — enterprise 승격)`);
    }
  }

  const entries = [...merged.values()].sort(
    (a, b) =>
      a.atsProvider.localeCompare(b.atsProvider) || a.slug.localeCompare(b.slug),
  );

  console.log(
    `\n시드 병합: 기존 ${preserved}개 보존 + 신규 ${added}개 추가` +
      `${demoted.length > 0 ? ` - enterprise 제외 ${demoted.length}개` : ''} = ${entries.length}개`,
  );
  for (const d of demoted) console.log(`  제외: ${d}`);

  const payload = {
    _comment:
      'discover-boards.ts가 4개 ATS에 실측 프로브해 응답이 확인된 보드만 기록한다. jobCount/size는 발굴 시점 스냅샷이며 변동한다.',
    _targeting:
      '시리즈 A~C 규모(공고 5~150건) 중심. enterprise(151건+)는 조달 프로세스로 프리랜서 콜드메일이 전환되지 않아 제외. 근거: 대기업 보드 2663건 중 freelance 표현 1건.',
    _excluded:
      '데모 보드(leverdemo 등)는 evergreen.ts의 DEMO_BOARD_SLUGS로 이중 차단한다.',
    _merge_policy:
      '이 파일은 병합으로 갱신된다. 프로브 일시 실패로 보드가 사라지면 scan.ts의 pruneBoards가 관측 이력까지 삭제하므로, 기존 항목은 enterprise 규모로 커진 경우에만 제외한다.',
    companies: entries,
  };

  await writeFile(
    path.join(ROOT, 'seeds/companies.json'),
    JSON.stringify(payload, null, 2) + '\n',
    'utf8',
  );

  console.log(
    `\nseeds/companies.json 갱신 완료: ${entries.length}개 보드\n` +
      `신규 추가된 보드의 관측 시계는 다음 스캔에서 시작됩니다.\n`,
  );
}

main().catch((e) => {
  console.error('오류:', e);
  process.exit(1);
});
