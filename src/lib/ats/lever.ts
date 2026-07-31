/**
 * Lever Postings API 커넥터.
 *
 * 엔드포인트: https://api.lever.co/v0/postings/{slug}?mode=json
 * 인증: 없음.
 * 검증: 2026-07-30, slug=shieldai/ro/matchgroup/leverdemo 응답 확인.
 *
 * 주의점 두 가지:
 * 1. 응답이 최상위 배열이다 (`{jobs: [...]}` 아님). 존재하지 않는 슬러그도
 *    404가 아니라 `200 []`을 반환한다. 따라서 빈 배열을 "슬러그 오류"와
 *    "채용 없음"으로 구분할 수 없다. 이는 파이프라인에서 연속 빈 응답
 *    횟수로 판단한다.
 * 2. `createdAt`이 epoch 밀리초다. ISO가 아니다.
 *
 * 관측된 응답 형태:
 * [{
 *   "id": "41468aca-c1c2-4a7b-aec8-f499e64b6d1e",
 *   "text": "Aerostructures Design Engineer II (R4953)",
 *   "createdAt": 1779920530389,
 *   "workplaceType": "onsite",
 *   "country": "US",
 *   "categories": {
 *     "commitment": "Full Time Employee",
 *     "department": "X-BAT Division",
 *     "team": "X-BAT Engineering - Aerostructures",
 *     "location": "United States",
 *     "allLocations": ["United States", "San Diego, California", "Dallas, Texas"]
 *   },
 *   "descriptionPlain": "...", "additionalPlain": "...",
 *   "hostedUrl": "...", "applyUrl": "...", "salaryRange": {...}
 * }]
 */

import { z } from 'zod';
import { fetchJson, HttpError } from './http.js';
import {
  nullifyBlank,
  parseAtsDate,
  parseLocations,
  resolveWorkplaceType,
  titleFingerprint,
} from './normalize.js';
import {
  AtsFetchError,
  type AtsConnector,
  type FetchJobsOptions,
  type FetchJobsResult,
  type NormalizedJob,
} from './types.js';

const BASE = 'https://api.lever.co/v0/postings';

const LeverJobSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    createdAt: z.union([z.number(), z.string()]).optional().nullable(),
    workplaceType: z.string().optional().nullable(),
    country: z.string().optional().nullable(),
    hostedUrl: z.string().optional().nullable(),
    applyUrl: z.string().optional().nullable(),
    descriptionPlain: z.string().optional().nullable(),
    additionalPlain: z.string().optional().nullable(),
    categories: z
      .object({
        commitment: z.string().optional().nullable(),
        department: z.string().optional().nullable(),
        team: z.string().optional().nullable(),
        location: z.string().optional().nullable(),
        allLocations: z.array(z.string()).optional().nullable(),
      })
      .passthrough()
      .optional()
      .nullable(),
  })
  .passthrough();

type LeverJob = z.infer<typeof LeverJobSchema>;

function toNormalized(raw: LeverJob, companySlug: string): NormalizedJob {
  const cat = raw.categories ?? {};
  const primaryLocation = nullifyBlank(cat.location);
  const allLocations = (cat.allLocations ?? []).filter(Boolean);

  // Lever는 본문을 descriptionPlain(주 설명) + additionalPlain(부가)으로 쪼갠다.
  // 기술스택은 양쪽에 흩어져 있으므로 합쳐야 한다.
  const descriptionText =
    [nullifyBlank(raw.descriptionPlain), nullifyBlank(raw.additionalPlain)]
      .filter(Boolean)
      .join('\n\n') || null;

  return {
    atsProvider: 'lever',
    companySlug,
    // Lever 공개 API는 회사 표시명을 주지 않는다. 슬러그만 있다.
    companyName: null,
    externalId: raw.id,
    title: raw.text.trim(),
    titleFingerprint: titleFingerprint(raw.text),
    department: nullifyBlank(cat.department),
    team: nullifyBlank(cat.team),
    employmentType: nullifyBlank(cat.commitment),
    locationRaw: primaryLocation,
    locations: parseLocations(primaryLocation, ...allLocations),
    workplaceType: resolveWorkplaceType(
      raw.workplaceType,
      [primaryLocation, ...allLocations].filter(Boolean).join(' | '),
    ),
    sourcePublishedAt: parseAtsDate(raw.createdAt),
    // Lever는 수정 시각을 공개하지 않는다.
    sourceUpdatedAt: null,
    jobUrl:
      nullifyBlank(raw.hostedUrl) ??
      `https://jobs.lever.co/${companySlug}/${raw.id}`,
    applyUrl: nullifyBlank(raw.applyUrl),
    descriptionText,
  };
}

export const leverConnector: AtsConnector = {
  provider: 'lever',

  boardUrl(companySlug: string): string {
    return `https://jobs.lever.co/${encodeURIComponent(companySlug)}`;
  },

  async fetchJobs(
    companySlug: string,
    options: FetchJobsOptions = {},
  ): Promise<FetchJobsResult> {
    const startedAt = Date.now();
    // Lever는 항상 본문을 포함해서 준다. includeContent로 줄일 수 없다.
    const url = `${BASE}/${encodeURIComponent(companySlug)}?mode=json`;

    let payload: unknown;
    try {
      payload = await fetchJson(url, { signal: options.signal });
    } catch (error) {
      throw new AtsFetchError(
        `Lever 보드 조회 실패: ${companySlug}`,
        'lever',
        companySlug,
        error,
        error instanceof HttpError ? error.status : undefined,
      );
    }

    if (!Array.isArray(payload)) {
      throw new AtsFetchError(
        `Lever 응답 구조 변경 감지: ${companySlug} — 최상위가 배열이 아님 (${typeof payload})`,
        'lever',
        companySlug,
      );
    }

    const warnings: string[] = [];
    const jobs: NormalizedJob[] = [];

    for (const [index, item] of payload.entries()) {
      const job = LeverJobSchema.safeParse(item);
      if (!job.success) {
        warnings.push(
          `job[${index}] 정규화 실패: ${job.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
        continue;
      }
      jobs.push(toNormalized(job.data, companySlug));
    }

    // Lever는 잘못된 슬러그에도 200 []을 준다. 호출자가 판단할 수 있게 신호를 남긴다.
    if (payload.length === 0) {
      warnings.push(
        'EMPTY_BOARD: 공고 0건. 슬러그 오류 또는 실제 채용 없음 — 연속 발생 시 시드 점검 필요',
      );
    }

    return {
      provider: 'lever',
      companySlug,
      jobs,
      warnings,
      rawCount: payload.length,
      fetchedAt: new Date(),
      durationMs: Date.now() - startedAt,
    };
  },
};
