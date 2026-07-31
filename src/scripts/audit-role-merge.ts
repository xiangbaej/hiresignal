/**
 * 직무 병합 감사.
 *
 *   npm run roles:audit
 *
 * ── 왜 필요한가 ──
 *
 * 회사 카드의 직무 접기는 지역 어휘 목록에 의존한다(src/lib/title-variant.ts).
 * 목록에 없는 지역 표현은 묶이지 않으므로, 이 필터는 정밀도를 위해 재현율을
 * 희생한다. 그런 필터는 무엇을 놓치고 있는지 볼 수 있어야 한다 -
 * audit-archive-evidence.ts 와 리포트의 직군 필터 감사 패널이 같은 이유로 있다.
 *
 * 어휘를 추측으로 늘리면 잘못된 병합만 늘어난다. 잘못 접히면 자리 하나가 화면에서
 * 사라지는데, 그건 놓친 병합보다 비싸다. 그래서 확장 근거를 데이터에서 만든다.
 *
 * ── 무엇을 보여주는가 ──
 *
 * 1) 놓친 병합 후보
 *    접미사를 전부 떼면 같은 제목이 되지만 현재는 따로 남은 묶음. 대부분은
 *    "따로 남는 게 맞는" 경우다(workos `Product Engineer - Enterprise /
 *    Identity and Auth / Radar` 는 전부 다른 제품). 지역 표현이 섞여 있을 때만
 *    어휘에 추가한다.
 *
 * 2) 미인식 접미사 낱말 빈도
 *    지역어가 상위에 올라오면 어휘 누락이다. 실측 상위는
 *    engineer / ai / data / infrastructure 처럼 전문분야어이며, 이게 정상이다.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { REGION_WORDS, isRegionLabel, roleKey, splitTitleRegion } from '../lib/title-variant.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_DIR = path.join(ROOT, 'data');

interface Lead {
  company: string;
  board: string;
  title: string;
  ageDays: number | null;
}

interface LeadsFile {
  leads: Lead[];
}

/** 접미사를 무조건 다 떼는 공격적 기준. 병합 후보의 상한을 본다. */
function aggressiveBase(title: string): string {
  let t = title.trim();
  // 중첩 접미사를 위해 반복한다. 4회면 실측 최대 깊이를 넘는다.
  for (let i = 0; i < 4; i++) {
    const paren = /^(.+?)\s*\([^()]+\)\s*$/.exec(t);
    if (paren?.[1]) {
      t = paren[1].trim();
      continue;
    }
    const dash = /^(.+?)\s*[-\u2010-\u2015]\s*[^-\u2010-\u2015]+$/.exec(t);
    if (dash?.[1]) {
      t = dash[1].trim();
      continue;
    }
    break;
  }
  return roleKey(t);
}

/** 제목 끝의 접미사(괄호 또는 대시 뒤)를 뽑는다. 없으면 null. */
function trailingSuffix(title: string): string | null {
  const t = title.trim();
  const paren = /\(([^()]+)\)\s*$/.exec(t);
  if (paren?.[1]) return paren[1];
  const dash = /[-\u2010-\u2015]\s*([^-\u2010-\u2015]+)$/.exec(t);
  return dash?.[1] ?? null;
}

async function main(): Promise<void> {
  const raw = await readFile(path.join(DATA_DIR, 'leads.json'), 'utf8');
  const { leads } = JSON.parse(raw) as LeadsFile;

  console.log(`리드 ${leads.length}건 / 지역 어휘 ${REGION_WORDS.size}개`);

  const byBoard = new Map<string, Lead[]>();
  for (const l of leads) {
    const key = l.board || l.company;
    const bucket = byBoard.get(key);
    if (bucket) bucket.push(l);
    else byBoard.set(key, [l]);
  }

  // --- 현재 병합 결과 요약 ---
  let seatTotal = 0;
  let roleTotal = 0;
  for (const [, ls] of byBoard) {
    const keys = new Set(ls.map((l) => roleKey(splitTitleRegion(l.title).base)));
    seatTotal += ls.length;
    roleTotal += keys.size;
  }
  console.log(
    `회사 ${byBoard.size}곳 · 공고 ${seatTotal}건 → 직무 ${roleTotal}개 ` +
      `(${seatTotal - roleTotal}건 접힘)`,
  );

  // --- 1) 놓친 병합 후보 ---
  console.log('');
  console.log('=== 놓친 병합 후보 (접미사 전부 제거 시 동일한데 현재는 분리) ===');
  console.log('    대부분은 분리가 맞다. 접미사에 지역 표현이 있을 때만 어휘에 추가한다.');

  let candidateGroups = 0;
  for (const [board, ls] of byBoard) {
    const groups = new Map<string, Lead[]>();
    for (const l of ls) {
      const ab = aggressiveBase(l.title);
      const bucket = groups.get(ab);
      if (bucket) bucket.push(l);
      else groups.set(ab, [l]);
    }

    for (const [ab, group] of groups) {
      if (group.length < 2) continue;
      const currentKeys = new Set(group.map((l) => roleKey(splitTitleRegion(l.title).base)));
      if (currentKeys.size < 2) continue; // 이미 하나로 묶였다

      candidateGroups++;
      console.log('');
      console.log(`  ${board}  "${ab}"  ${group.length}건 → 현재 ${currentKeys.size}묶음`);
      for (const l of group) {
        const { region } = splitTitleRegion(l.title);
        const suffix = trailingSuffix(l.title);
        const mark = region ? '지역인식' : suffix ? '미인식  ' : '접미사없음';
        console.log(
          `      ${String(l.ageDays ?? '?').padStart(5)}일  [${mark}] ${l.title}`,
        );
      }
    }
  }
  console.log('');
  console.log(`  후보 ${candidateGroups}건`);

  // --- 2) 미인식 접미사 낱말 빈도 ---
  console.log('');
  console.log('=== 미인식 접미사 낱말 상위 30 ===');
  console.log('    지역어가 상위에 있으면 어휘 누락이다. 전문분야어가 상위인 것이 정상이다.');

  const freq = new Map<string, number>();
  for (const l of leads) {
    const suffix = trailingSuffix(l.title);
    if (!suffix || isRegionLabel(suffix)) continue;
    for (const w of suffix.toLowerCase().split(/[\s/&,+()\u2010-\u2015-]+/).filter(Boolean)) {
      if (REGION_WORDS.has(w)) continue;
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }

  const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  console.log('');
  for (const [w, n] of top) {
    console.log(`  ${String(n).padStart(4)}  ${w}`);
  }

  if (top.length === 0) {
    console.log('  (미인식 접미사 없음)');
  }
}

main().catch((e) => {
  console.error('오류:', e);
  process.exit(1);
});
