/**
 * Greenhouse Job Board API 커넥터.
 *
 * 엔드포인트: https://boards-api.greenhouse.io/v1/boards/{slug}/jobs
 * 인증: 없음. 공개 배포 엔드포인트.
 * 검증: 2026-07-30, slug=stripe, 539건 응답 확인.
 *
 * 이 커넥터가 중요한 이유: Greenhouse는 `first_published`를 별도 필드로 준다.
 * `updated_at`과 분리되어 있어서, 회사가 공고를 수정해도 최초 게시일이 보존된다.
 * 즉 staleness를 첫 스캔부터 정확히 계산할 수 있다.
 *
 * 관측된 응답 형태:
 * {
 *   "jobs": [{
 *     "id": 7954688,
 *     "internal_job_id": 3453698,
 *     "title": "Account Executive, AI Sales (Grower)",
 *     "updated_at": "2026-07-27T11:17:30-04:00",
 *     "first_published": "2026-06-02T08:58:57-04:00",
 *     "requisition_id": "See Opening ID",
 *     "location": { "name": "San Francisco, CA" },
 *     "absolute_url": "https://stripe.com/jobs/search?gh_jid=7954688",
 *     "company_name": "Stripe",
 *     "metadata": null,
 *     "content": "<html-escaped>"        // content=true 일 때만
 *     "departments": [{ "name": "..." }],  // content=true 일 때만
 *     "offices": [{ "name": "..." }]       // content=true 일 때만
 *   }],
 *   "meta": { "total": 539 }
 * }
 */

import { z } from 'zod';
import { fetchJson, HttpError } from './http.js';
import {
  htmlToPlainText,
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

const BASE = 'https://boards-api.greenhouse.io/v1/boards';

/**
 * 스키마는 의도적으로 관대하다. `passthrough`로 미지의 필드를 허용하고,
 * 우리가 실제로 쓰는 필드만 검증한다. Greenhouse가 새 필드를 추가해도
 * 스캔이 죽지 않아야 한다.
 */
const GreenhouseJobSchema = z
  .object({
    id: z.union([z.number(), z.string()]),
    title: z.string(),
    absolute_url: z.string().optional().nullable(),
    // 최초 게시일. 이 필드가 없는 보드도 있어서 updated_at 폴백이 필요하다.
    first_published: z.string().optional().nullable(),
    updated_at: z.string().optional().nullable(),
    requisition_id: z.string().optional().nullable(),
    company_name: z.string().optional().nullable(),
    location: z.object({ name: z.string().optional().nullable() }).optional().nullable(),
    offices: z.array(z.object({ name: z.string().optional().nullable() })).optional().nullable(),
    departments: z
      .array(z.object({ name: z.string().optional().nullable() }))
      .optional()
      .nullable(),
    content: z.string().optional().nullable(),
    metadata: z.unknown().optional().nullable(),
  })
  .passthrough();

const GreenhouseResponseSchema = z
  .object({
    jobs: z.array(z.unknown()),
    meta: z.object({ total: z.number().optional() }).passthrough().optional(),
  })
  .passthrough();

type GreenhouseJob = z.infer<typeof GreenhouseJobSchema>;

function toNormalized(
  raw: GreenhouseJob,
  companySlug: string,
): NormalizedJob {
  const officeNames = (raw.offices ?? [])
    .map((o) => nullifyBlank(o?.name))
    .filter((v): v is string => v !== null);

  const locationRaw = nullifyBlank(raw.location?.name);

  const departmentNames = (raw.departments ?? [])
    .map((d) => nullifyBlank(d?.name))
    .filter((v): v is string => v !== null);

  // Greenhouse는 원격 여부를 별도 필드로 주지 않는다. 위치 문자열로만 추정.
  const workplaceType = resolveWorkplaceType(
    null,
    [locationRaw, ...officeNames].filter(Boolean).join(' | '),
  );

  const descriptionText = raw.content
    ? htmlToPlainText(raw.content) || null
    : null;

  return {
    atsProvider: 'greenhouse',
    companySlug,
    companyName: nullifyBlank(raw.company_name),
    externalId: String(raw.id),
    title: raw.title.trim(),
    titleFingerprint: titleFingerprint(raw.title),
    department: departmentNames[0] ?? null,
    team: departmentNames[1] ?? null,
    // Greenhouse 공개 API는 고용형태를 노출하지 않는다.
    employmentType: null,
    locationRaw,
    locations: parseLocations(locationRaw, ...officeNames),
    workplaceType,
    sourcePublishedAt: parseAtsDate(raw.first_published),
    sourceUpdatedAt: parseAtsDate(raw.updated_at),
    jobUrl:
      nullifyBlank(raw.absolute_url) ??
      `https://boards.greenhouse.io/${companySlug}/jobs/${raw.id}`,
    applyUrl: nullifyBlank(raw.absolute_url),
    descriptionText,
  };
}

export const greenhouseConnector: AtsConnector = {
  provider: 'greenhouse',

  boardUrl(companySlug: string): string {
    return `https://boards.greenhouse.io/${encodeURIComponent(companySlug)}`;
  },

  async fetchJobs(
    companySlug: string,
    options: FetchJobsOptions = {},
  ): Promise<FetchJobsResult> {
    const startedAt = Date.now();
    // content=true는 본문 + departments + offices까지 준다. 대신 페이로드가 커진다.
    const url =
      `${BASE}/${encodeURIComponent(companySlug)}/jobs` +
      `?content=${options.includeContent ? 'true' : 'false'}`;

    let payload: unknown;
    try {
      payload = await fetchJson(url, { signal: options.signal });
    } catch (error) {
      throw new AtsFetchError(
        `Greenhouse 보드 조회 실패: ${companySlug}`,
        'greenhouse',
        companySlug,
        error,
        error instanceof HttpError ? error.status : undefined,
      );
    }

    const parsed = GreenhouseResponseSchema.safeParse(payload);
    if (!parsed.success) {
      // 최상위 구조가 깨진 것은 스키마 드리프트다. 조용히 넘기면 안 된다.
      throw new AtsFetchError(
        `Greenhouse 응답 구조 변경 감지: ${companySlug} — ${parsed.error.issues[0]?.message}`,
        'greenhouse',
        companySlug,
        parsed.error,
      );
    }

    const warnings: string[] = [];
    const jobs: NormalizedJob[] = [];

    // 공고 단위로 실패를 격리한다. 한 건이 깨져도 나머지는 살린다.
    for (const [index, item] of parsed.data.jobs.entries()) {
      const job = GreenhouseJobSchema.safeParse(item);
      if (!job.success) {
        warnings.push(
          `job[${index}] 정규화 실패: ${job.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
        continue;
      }
      jobs.push(toNormalized(job.data, companySlug));
    }

    // first_published 결측률이 높으면 staleness 신뢰도가 떨어지므로 경고로 남긴다.
    const missingPublishDate = jobs.filter((j) => !j.sourcePublishedAt).length;
    if (jobs.length > 0 && missingPublishDate / jobs.length > 0.5) {
      warnings.push(
        `first_published 결측 ${missingPublishDate}/${jobs.length}건 — staleness는 first_seen_at 폴백 사용`,
      );
    }

    return {
      provider: 'greenhouse',
      companySlug,
      jobs,
      warnings,
      rawCount: parsed.data.jobs.length,
      fetchedAt: new Date(),
      durationMs: Date.now() - startedAt,
    };
  },
};
