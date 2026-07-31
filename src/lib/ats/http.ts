/**
 * ATS 호출용 HTTP 레이어.
 *
 * 공개 job board API는 인증이 없지만 레이트리밋은 있다. 429/5xx는 지수 백오프로
 * 재시도하고, 4xx(429 제외)는 즉시 포기한다 — 슬러그 오류를 재시도해봐야 낭비다.
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS ?? 20_000);
const DEFAULT_RETRIES = 3;

/**
 * 공개 API지만 식별 가능한 UA를 보내는 편이 낫다. 차단 시 연락받을 수 있고,
 * 익명 UA보다 레이트리밋이 관대한 경우가 있다.
 */
const USER_AGENT =
  'HireSignal/0.1 (+https://hiresignal.dev; ATS job-board aggregator)';

export interface JsonFetchOptions {
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    readonly bodySnippet?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 429/5xx/네트워크 오류만 재시도 대상 */
function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) {
    return err.status === 429 || err.status >= 500;
  }
  // AbortError(외부 취소)는 재시도하지 않지만, 타임아웃은 재시도한다.
  if (err instanceof Error && err.name === 'TimeoutError') return true;
  if (err instanceof Error && err.name === 'AbortError') return false;
  return true; // fetch 네트워크 오류
}

export async function fetchJson<T = unknown>(
  url: string,
  options: JsonFetchOptions = {},
): Promise<T> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    signal,
    headers = {},
  } = options;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) throw new Error('aborted');

    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      const e = new Error(`timeout after ${timeoutMs}ms`);
      e.name = 'TimeoutError';
      timeoutController.abort(e);
    }, timeoutMs);

    // 외부 취소 신호를 타임아웃 컨트롤러에 연결
    const onExternalAbort = () => timeoutController.abort(signal?.reason);
    signal?.addEventListener('abort', onExternalAbort, { once: true });

    try {
      const res = await fetch(url, {
        headers: {
          accept: 'application/json',
          'user-agent': USER_AGENT,
          ...headers,
        },
        signal: timeoutController.signal,
        redirect: 'follow',
      });

      if (!res.ok) {
        const snippet = (await res.text().catch(() => '')).slice(0, 300);
        throw new HttpError(
          `HTTP ${res.status} ${res.statusText}`,
          res.status,
          url,
          snippet,
        );
      }

      return (await res.json()) as T;
    } catch (err) {
      lastError = err;

      // 타임아웃 컨트롤러가 던진 원인을 정확히 복원
      if (
        err instanceof Error &&
        err.name === 'AbortError' &&
        timeoutController.signal.reason instanceof Error
      ) {
        lastError = timeoutController.signal.reason;
      }

      if (attempt === retries || !isRetryable(lastError)) break;

      // 지수 백오프 + 지터 (동시 스캔이 같은 순간에 몰리는 것 방지)
      const backoff = 2 ** attempt * 500 + Math.random() * 400;
      await sleep(backoff);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  throw lastError;
}

/**
 * 고정 동시성으로 작업을 처리한다. 결과는 입력 순서를 유지하고,
 * 개별 실패는 배열에 담아 반환해 전체 스캔이 중단되지 않게 한다.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: unknown }>> {
  const results: Array<
    { ok: true; value: R } | { ok: false; error: unknown }
  > = new Array(items.length);
  let cursor = 0;

  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= items.length) return;
        const item = items[index] as T;
        try {
          results[index] = { ok: true, value: await worker(item, index) };
        } catch (error) {
          results[index] = { ok: false, error };
        }
      }
    },
  );

  await Promise.all(runners);
  return results;
}
