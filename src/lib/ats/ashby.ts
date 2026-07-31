/**
 * Ashby Posting API 커넥터.
 *
 * 엔드포인트: https://api.ashbyhq.com/posting-api/job-board/{slug}
 * 인증: 없음.
 * 검증: 2026-07-30, slug=ashby 응답 확인.
 *
 * Ashby는 4개 ATS 중 가장 깔끔한 스키마를 준다. `isRemote` 불리언과
 * `workplaceType` 문자열을 모두 제공하고, `isListed`로 비공개 공고를 구분한다.
 * `isListed: false`는 보드에 노출되지 않는 공고이므로 리드로 쓰면 안 된다.
 *
 * 관측된 응답 형태:
 * {
 *   "jobs": [{
 *     "id": "2b401986-...",
 *     "title": "Strategic Customer Success Manager - Americas",
 *     "department": "Customer Success",
 *     "team": "Strategic Customer Success",
 *     "employmentType": "FullTime",
 *     "location": "Remote - US",
 *     "secondaryLocations": [],
 *     "publishedAt": "2026-06-30T19:02:11.162+00:00",
 *     "isListed": true,
 *     "isRemote": true,
 *     "workplaceType": "Remote",
 *     "address": { "postalAddress": {...} },
 *     "jobUrl": "...", "applyUrl": "...",
 *     "descriptionHtml": "...", "descriptionPlain": "...",
 *     "compensation": {...}
 *   }]
 * }
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

const BASE = 'https://api.ashbyhq.com/posting-api/job-board';

/** secondaryLocations는 문자열 배열 또는 객체 배열로 온 사례가 모두 있다. */
const SecondaryLocationSchema = z.union([
  z.string(),
  z.object({ location: z.string().optional().nullable() }).passthrough(),
]);

const AshbyJobSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    department: z.string().optional().nullable(),
    team: z.string().optional().nullable(),
    employmentType: z.string().optional().nullable(),
    location: z.string().optional().nullable(),
    secondaryLocations: z.array(SecondaryLocationSchema).optional().nullable(),
    publishedAt: z.string().optional().nullable(),
    isListed: z.boolean().optional().nullable(),
    isRemote: z.boolean().optional().nullable(),
    workplaceType: z.string().optional().nullable(),
    jobUrl: z.string().optional().nullable(),
    applyUrl: z.string().optional().nullable(),
    descriptionPlain: z.string().optional().nullable(),
  })
  .passthrough();

const AshbyResponseSchema = z
  .object({ jobs: z.array(z.unknown()) })
  .passthrough();

type AshbyJob = z.infer<typeof AshbyJobSchema>;

function secondaryToStrings(
  values: z.infer<typeof SecondaryLocationSchema>[] | null | undefined,
): string[] {
  return (values ?? [])
    .map((v) => (typeof v === 'string' ? v : nullifyBlank(v.location)))
    .filter((v): v is string => !!v);
}

function toNormalized(raw: AshbyJob, companySlug: string): NormalizedJob {
  const primaryLocation = nullifyBlank(raw.location);
  const secondary = secondaryToStrings(raw.secondaryLocations);

  return {
    atsProvider: 'ashby',
    companySlug,
    companyName: null,
    externalId: raw.id,
    title: raw.title.trim(),
    titleFingerprint: titleFingerprint(raw.title),
    department: nullifyBlank(raw.department),
    team: nullifyBlank(raw.team),
    employmentType: nullifyBlank(raw.employmentType),
    locationRaw: primaryLocation,
    locations: parseLocations(primaryLocation, ...secondary),
    // workplaceType 문자열을 우선하고, 없으면 isRemote 불리언으로 폴백.
    workplaceType: resolveWorkplaceType(
      raw.workplaceType ?? raw.isRemote,
      [primaryLocation, ...secondary].filter(Boolean).join(' | '),
    ),
    sourcePublishedAt: parseAtsDate(raw.publishedAt),
    sourceUpdatedAt: null,
    jobUrl:
      nullifyBlank(raw.jobUrl) ??
      `https://jobs.ashbyhq.com/${companySlug}/${raw.id}`,
    applyUrl: nullifyBlank(raw.applyUrl),
    descriptionText: nullifyBlank(raw.descriptionPlain),
  };
}

export const ashbyConnector: AtsConnector = {
  provider: 'ashby',

  boardUrl(companySlug: string): string {
    return `https://jobs.ashbyhq.com/${encodeURIComponent(companySlug)}`;
  },

  async fetchJobs(
    companySlug: string,
    options: FetchJobsOptions = {},
  ): Promise<FetchJobsResult> {
    const startedAt = Date.now();
    const url = `${BASE}/${encodeURIComponent(companySlug)}`;

    let payload: unknown;
    try {
      payload = await fetchJson(url, { signal: options.signal });
    } catch (error) {
      throw new AtsFetchError(
        `Ashby 보드 조회 실패: ${companySlug}`,
        'ashby',
        companySlug,
        error,
        error instanceof HttpError ? error.status : undefined,
      );
    }

    const parsed = AshbyResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AtsFetchError(
        `Ashby 응답 구조 변경 감지: ${companySlug} — ${parsed.error.issues[0]?.message}`,
        'ashby',
        companySlug,
        parsed.error,
      );
    }

    const warnings: string[] = [];
    const jobs: NormalizedJob[] = [];
    let unlisted = 0;

    for (const [index, item] of parsed.data.jobs.entries()) {
      const job = AshbyJobSchema.safeParse(item);
      if (!job.success) {
        warnings.push(
          `job[${index}] 정규화 실패: ${job.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
        continue;
      }
      // 보드에 노출되지 않는 공고는 리드 신호로 쓸 수 없다.
      if (job.data.isListed === false) {
        unlisted++;
        continue;
      }
      jobs.push(toNormalized(job.data, companySlug));
    }

    if (unlisted > 0) {
      warnings.push(`isListed=false ${unlisted}건 제외`);
    }

    return {
      provider: 'ashby',
      companySlug,
      jobs,
      warnings,
      rawCount: parsed.data.jobs.length,
      fetchedAt: new Date(),
      durationMs: Date.now() - startedAt,
    };
  },
};
