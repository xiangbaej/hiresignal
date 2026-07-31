/**
 * Wayback CDX 조회 결과 캐시.
 *
 * ── 왜 캐싱이 필수인가 ──
 *
 * URL의 "최초 아카이브 시각"은 시간이 지나도 **변하지 않는다**(과거는 고정이다).
 * 따라서 공고 1건당 평생 1회만 조회하면 된다. 매일 2,000건을 재조회하는 것은
 * archive.org에 대한 남용이고 우리 스캔도 느려진다.
 *
 * 예외: 캡처가 없던 URL은 나중에 아카이브될 수 있으므로 일정 기간 후 재시도한다.
 * 실측 커버리지가 57%였으므로 43%가 이 재시도 대상이 된다.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 캡처가 없던 URL을 다시 조회하기까지의 대기 일수 */
export const NEGATIVE_RECHECK_DAYS = 30;

const MS_PER_DAY = 86_400_000;

export interface ArchiveEntry {
  /** 우리가 조회한 시각 */
  probedAt: string;
  /** 캡처 수. 0이면 아카이브 없음. */
  captures: number;
  /** 최초 캡처 타임스탬프 (YYYYMMDDhhmmss). 캡처 없으면 null. */
  oldestStamp: string | null;
}

interface PersistedCache {
  version: 1;
  entries: Record<string, ArchiveEntry>;
}

/** CDX 타임스탬프 → Date */
export function stampToDate(stamp: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(stamp);
  if (!m) return null;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export class ArchiveCache {
  private entries = new Map<string, ArchiveEntry>();
  private dirty = false;
  private loaded = false;

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as PersistedCache;
      if (parsed.version !== 1) {
        throw new Error(`알 수 없는 archive-cache 버전: ${parsed.version}`);
      }
      this.entries = new Map(Object.entries(parsed.entries));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    this.loaded = true;
  }

  get(url: string): ArchiveEntry | undefined {
    return this.entries.get(url);
  }

  set(url: string, entry: ArchiveEntry): void {
    this.entries.set(url, entry);
    this.dirty = true;
  }

  /** 이 URL을 (재)조회해야 하는가 */
  needsProbe(url: string, now: Date = new Date()): boolean {
    const entry = this.entries.get(url);
    if (!entry) return true;
    // 캡처가 있으면 영구 확정. 다시 조회할 이유가 없다.
    if (entry.captures > 0) return false;
    // 캡처가 없었으면 일정 기간 후 재시도한다.
    const age = (now.getTime() - new Date(entry.probedAt).getTime()) / MS_PER_DAY;
    return age >= NEGATIVE_RECHECK_DAYS;
  }

  /**
   * 아카이브가 증명하는 최소 경과일.
   * 이 값은 **하한**이다. null이면 증거 없음이며 "새 공고"를 의미하지 않는다.
   */
  archiveAgeDays(url: string, now: Date = new Date()): number | null {
    const entry = this.entries.get(url);
    if (!entry || entry.captures <= 0 || !entry.oldestStamp) return null;
    const oldest = stampToDate(entry.oldestStamp);
    if (!oldest) return null;
    return Math.floor((now.getTime() - oldest.getTime()) / MS_PER_DAY);
  }

  get size(): number {
    return this.entries.size;
  }

  get positiveCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.captures > 0) n++;
    return n;
  }

  async flush(): Promise<void> {
    if (!this.loaded) throw new Error('load()를 먼저 호출해야 합니다.');
    if (!this.dirty) return;

    const payload: PersistedCache = {
      version: 1,
      entries: Object.fromEntries(this.entries),
    };
    const tmp = `${this.filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(payload), 'utf8');
    await rename(tmp, this.filePath);
    this.dirty = false;
  }
}
