/**
 * 제외 목록(opt-out) 적용.
 *
 * ── 왜 코드로 강제하는가 ──
 *
 * 이 프로젝트는 ATS가 자사 채용 페이지 구축용으로 제공하는 공개 API를 제3자
 * 관점으로 집계한다. 명문 금지는 없지만 의도된 용법도 아니다. 저장소가 공개된
 * 이상 "우리 공고를 빼 달라"는 요청이 올 수 있고, 그때 즉시 응할 수 있어야 한다.
 *
 * 문서에만 "요청하면 빼드립니다"라고 적어두는 것은 실효가 없다. 파이프라인이
 * 실제로 참조하는 파일이어야 하고, 제외 후 **기존에 누적된 관측까지 삭제**되어야
 * 한다. 그래서 다음 두 지점에서 강제한다:
 *
 *   1. discover-boards.ts — 발굴 단계에서 시드 승격을 차단
 *   2. scan.ts — 시드에 남아 있어도 스캔 대상에서 제외.
 *      제외된 보드는 활성 목록에서 빠지므로 pruneBoards가 누적 관측을 정리한다.
 *
 * 즉 제외 요청 다음 실행에서 데이터가 실제로 사라진다.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BLOCKLIST_PATH = path.join(ROOT, 'seeds/blocklist.json');

export interface Blocklist {
  /** `ats:slug` 형식. 특정 ATS 보드만 제외. */
  boards: ReadonlySet<string>;
  /** 슬러그. 모든 ATS에서 제외. */
  companies: ReadonlySet<string>;
  /** 제외 항목이 하나라도 있는지 */
  readonly size: number;
}

const EMPTY: Blocklist = {
  boards: new Set(),
  companies: new Set(),
  size: 0,
};

/**
 * 제외 목록을 읽는다.
 *
 * 파일이 없으면 빈 목록으로 동작한다. 하지만 **파싱 실패는 던진다** — 파일이
 * 깨졌는데 조용히 빈 목록으로 넘어가면 제외 요청을 무시한 채 수집을 계속하게
 * 된다. 그건 이 기능이 존재하는 이유를 정면으로 배반한다. 차라리 스캔을 멈추는
 * 편이 낫다.
 */
export async function loadBlocklist(): Promise<Blocklist> {
  let raw: string;
  try {
    raw = await readFile(BLOCKLIST_PATH, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return EMPTY;
    throw err;
  }

  let parsed: { boards?: unknown; companies?: unknown };
  try {
    parsed = JSON.parse(raw) as { boards?: unknown; companies?: unknown };
  } catch (err) {
    throw new Error(
      `seeds/blocklist.json 파싱 실패. 제외 요청을 무시한 채 수집을 계속할 수 없으므로 중단합니다: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const toSet = (value: unknown, field: string): Set<string> => {
    if (value === undefined || value === null) return new Set();
    if (!Array.isArray(value)) {
      throw new Error(`seeds/blocklist.json의 ${field}는 배열이어야 합니다.`);
    }
    return new Set(
      value
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim().toLowerCase())
        .filter((v) => v.length > 0),
    );
  };

  const boards = toSet(parsed.boards, 'boards');
  const companies = toSet(parsed.companies, 'companies');

  return { boards, companies, size: boards.size + companies.size };
}

/** 해당 보드가 제외 대상인가 */
export function isBlocked(
  blocklist: Blocklist,
  atsProvider: string,
  slug: string,
): boolean {
  const normalizedSlug = slug.trim().toLowerCase();
  return (
    blocklist.companies.has(normalizedSlug) ||
    blocklist.boards.has(`${atsProvider.toLowerCase()}:${normalizedSlug}`)
  );
}
