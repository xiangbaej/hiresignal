/**
 * 원장 회귀 검사 (append-only 불변식 검증).
 *
 * ── 왜 필요한가 ──
 *
 * 2026-07-31 에 실제로 사고가 났다. 봇이 커밋한 일일 스냅샷(`d9e9ec9`, 관측
 * 5,558줄 + 실행 기록 1줄)을 로컬 세션이 스테일한 `data/` 로 덮어써서 커밋했고
 * (`9f95905`), 원장에서 그 실행이 통째로 사라졌다. 관측은 사후에 메울 수 없는
 * 자산이므로 이 사고는 조용히 지나가면 안 된다.
 *
 * 앱 코드에는 원장을 줄일 경로가 없다 — `FileSnapshotStore` 는 `appendFile` 만
 * 쓰고, `pruneBoards` 도 주석에 명시된 대로 `snapshots.jsonl` 을 건드리지 않는다.
 * 즉 손실은 항상 git 경로(체크아웃/리베이스/스테일 작업트리 커밋)에서 온다.
 * 그래서 검사도 앱 런타임이 아니라 커밋 직전에 둔다.
 *
 * ── 불변식 ──
 *
 * 원장이 append-only 라면 **비교 기준(ref)의 파일 내용은 현재 작업트리 파일의
 * 접두사**여야 한다. 줄이 사라졌거나 중간이 바뀌었으면 접두사가 깨진다.
 * 길이만 비교하면 "5,558줄 지우고 5,558줄 추가"를 놓치므로 줄 단위로 본다.
 *
 * 사용:
 *   npm run ledger:check            # HEAD 와 비교
 *   npm run ledger:check -- --ref origin/main
 */

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/** 검사 대상. append-only 원장만 넣는다 — state/leads 는 파생물이라 재작성이 정상이다. */
const LEDGERS = ['data/snapshots.jsonl', 'data/runs.jsonl'] as const;

interface Violation {
  file: string;
  kind: 'shrunk' | 'diverged' | 'missing';
  detail: string;
}

function parseRef(argv: string[]): string {
  const i = argv.indexOf('--ref');
  if (i !== -1) {
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error('--ref 다음에 비교할 커밋을 지정해야 합니다.');
    }
    return value;
  }
  return 'HEAD';
}

/** ref 의 파일 내용을 읽는다. ref 에 해당 파일이 없으면 null. */
function readFromRef(ref: string, file: string): string | null {
  try {
    return execFileSync('git', ['show', `${ref}:${file}`], {
      maxBuffer: 1 << 30,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function splitLines(text: string): string[] {
  return text.split('\n').filter((l) => l.length > 0);
}

async function main(): Promise<void> {
  const ref = parseRef(process.argv.slice(2));

  // ref 가 실제로 존재하는지 먼저 확인한다. 없으면 검사 자체가 무의미하다.
  try {
    execFileSync('git', ['rev-parse', '--verify', ref], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch {
    console.log(`[ledger:check] ${ref} 를 확인할 수 없습니다 (첫 커밋 전?) — 검사를 건너뜁니다.`);
    return;
  }

  const violations: Violation[] = [];

  for (const file of LEDGERS) {
    const base = readFromRef(ref, file);
    if (base === null) {
      console.log(`  ${file.padEnd(22)} ${ref} 에 없음 — 신규 파일로 간주하고 건너뜁니다.`);
      continue;
    }

    let current: string;
    try {
      current = await readFile(file, 'utf8');
    } catch {
      violations.push({
        file,
        kind: 'missing',
        detail: `${ref} 에는 있으나 작업트리에 없습니다.`,
      });
      continue;
    }

    const baseLines = splitLines(base);
    const curLines = splitLines(current);

    if (curLines.length < baseLines.length) {
      violations.push({
        file,
        kind: 'shrunk',
        detail:
          `${baseLines.length}줄 → ${curLines.length}줄 (${baseLines.length - curLines.length}줄 감소). ` +
          `원장은 줄어들 수 없습니다.`,
      });
      continue;
    }

    // 접두사 검사. 첫 불일치 지점을 찾아 알려준다.
    let mismatch = -1;
    for (let i = 0; i < baseLines.length; i++) {
      if (baseLines[i] !== curLines[i]) {
        mismatch = i;
        break;
      }
    }

    if (mismatch !== -1) {
      const was = (baseLines[mismatch] ?? '').slice(0, 120);
      const now = (curLines[mismatch] ?? '').slice(0, 120);
      violations.push({
        file,
        kind: 'diverged',
        detail:
          `${mismatch + 1}번째 줄부터 어긋납니다. 과거 기록이 수정되었습니다.\n` +
          `      ${ref}: ${was}\n` +
          `      작업트리: ${now}`,
      });
      continue;
    }

    const added = curLines.length - baseLines.length;
    console.log(
      `  ${file.padEnd(22)} OK  ${baseLines.length}줄 유지 + ${added}줄 추가 = ${curLines.length}줄`,
    );
  }

  if (violations.length === 0) {
    console.log('');
    console.log(`[ledger:check] append-only 불변식 통과 (기준: ${ref})`);
    return;
  }

  console.error('');
  console.error(`[ledger:check] 원장 회귀를 감지했습니다 (기준: ${ref})`);
  for (const v of violations) {
    console.error(`  ✗ ${v.file} [${v.kind}]`);
    console.error(`      ${v.detail}`);
  }
  console.error('');
  console.error('관측 이력은 사후에 메울 수 없습니다. 커밋하기 전에 아래를 확인하세요.');
  console.error(`  1) 원격의 봇 커밋을 먼저 받았는지:  git pull --rebase`);
  console.error(`  2) 사라진 줄을 되살릴 수 있는지:     git show ${ref}:data/snapshots.jsonl`);
  console.error('의도한 재작성이라면 이 검사를 건너뛰지 말고 사유를 커밋 메시지에 남기세요.');
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('[ledger:check] 검사 중 오류:', err);
  process.exitCode = 1;
});
