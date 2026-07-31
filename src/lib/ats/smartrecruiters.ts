/**
 * SmartRecruiters Posting API 커넥터.
 *
 * 엔드포인트: https://api.smartrecruiters.com/v1/companies/{company}/postings
 * 인증: 없음.
 * 검증: 2026-07-30, company=Visa / SmartRecruiters 응답 확인.
 *
 * 4개 ATS 중 유일하게 페이지네이션이 필요하다 (limit/offset, 최대 100).
 * 대신 `location.remote` / `location.hybrid` 불리언과 `company.name`을 주므로
 * 근무형태와 회사명 정확도가 가장 높다.
 *
 * 목록 응답에는 본문이 없다. 본문은 공고별 상세 호출(`ref`)이 필요해서
 * N+1이 된다. 따라서 `includeContent`는 기본 false이고, 켜더라도 상한을 둔다.
 *
 * 관측된 목록 응답 형태:
 * {
 *   "offset": 0, "limit": 3, "totalFound": 2,
 *   "content": [{
 *     "id": "744000133907678",
 *     "name": "Sr. Manager",
 *     "refNumber": "REF97395W",
 *     "company": { "identifier": "Visa", "name": "Visa" },
 *     "releasedDate": "2026-06-24T10:00:11.853Z",
 *     "location": { "city": "Austin", "region": "TX", "country": "us",
 *                   "remote": false, "hybrid": false,
 *                   "fullLocation": "Austin, TX, United States" },
 *     "department": { "id": "868639", "label": "Software Development/Engineering" },
 *     "function": { "id": "engineering", "label": "Engineering" },
 *     "typeOfEmployment": { "id": "permanent", "label": "Full-time" },
 *     "visibility": "PUBLIC",
 *     "ref": "https://api.smartrecruiters.com/v1/companies/Visa/postings/744..."
 *   }]
 * }
 */

import { z } from 'zod';
import { fetchJson, HttpError, mapWithConcurrency } from './http.js';
import {
  htmlToPlainText,
  nullifyBlank,
  parseAtsDate,
  parseLocations,
  titleFingerprint,
} from './normalize.js';
import {
  AtsFetchError,
  type AtsConnector,
  type FetchJobsOptions,
  type FetchJobsResult,
  type NormalizedJob,
  type WorkplaceType,
} from './types.js';

const BASE = 'https://api.smartrecruiters.com/v1/companies';
/** API가 허용하는 페이지 크기 상한 */
const PAGE_SIZE = 100;
/** 무한 루프 방어. 100 * 30 = 3,000건이면 어떤 회사든 충분하다. */
const MAX_PAGES = 30;
/** includeContent 시 상세 호출 상한. N+1 폭주를 막는다. */
const MAX_DETAIL_FETCHES = 200;

const LabeledSchema = z
  .object({ id: z.string().optional().nullable(), label: z.string().optional().nullable() })
  .passthrough();

const SmartRecruitersPostingSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    name: z.string(),
    refNumber: z.string().optional().nullable(),
    releasedDate: z.string().optional().nullable(),
    visibility: z.string().optional().nullable(),
    ref: z.string().optional().nullable(),
    company: z
      .object({
        identifier: z.string().optional().nullable(),
        name: z.string().optional().nullable(),
      })
      .passthrough()
      .optional()
      .nullable(),
    location: z
      .object({
        city: z.string().optional().nullable(),
        region: z.string().optional().nullable(),
        country: z.string().optional().nullable(),
        remote: z.boolean().optional().nullable(),
        hybrid: z.boolean().optional().nullable(),
        fullLocation: z.string().optional().nullable(),
      })
      .passthrough()
      .optional()
      .nullable(),
    department: LabeledSchema.optional().nullable(),
    function: LabeledSchema.optional().nullable(),
    typeOfEmployment: LabeledSchema.optional().nullable(),
  })
  .passthrough();

const SmartRecruitersListSchema = z
  .object({
    content: z.array(z.unknown()),
    totalFound: z.number().optional(),
    offset: z.number().optional(),
    limit: z.number().optional(),
  })
  .passthrough();

/** 상세 응답의 jobAd.sections는 섹션별 {title, text} 구조다. */
const SectionSchema = z
  .object({ title: z.string().optional().nullable(), text: z.string().optional().nullable() })
  .passthrough();

const SmartRecruitersDetailSchema = z
  .object({
    jobAd: z
      .object({
        sections: z.record(SectionSchema).optional().nullable(),
      })
      .passthrough()
      .optional()
      .nullable(),
  })
  .passthrough();

type SmartRecruitersPosting = z.infer<typeof SmartRecruitersPostingSchema>;

/**
 * remote/hybrid 불리언이 명시적으로 오므로 휴리스틱이 필요 없다.
 * 이 ATS만 근무형태를 확정적으로 판정할 수 있다.
 */
function resolveWorkplace(
  location: SmartRecruitersPosting['location'],
): WorkplaceType {
  if (!location) return 'unknown';
  if (location.remote === true) return 'remote';
  if (location.hybrid === true) return 'hybrid';
  if (location.remote === false && location.hybrid === false) return 'onsite';
  return 'unknown';
}

function buildLocationString(
  location: SmartRecruitersPosting['location'],
): string | null {
  if (!location) return null;
  const full = nullifyBlank(location.fullLocation);
  if (full) return full;
  const parts = [location.city, location.region, location.country]
    .map((v) => nullifyBlank(v))
    .filter((v): v is string => v !== null);
  return parts.length > 0 ? parts.join(', ') : null;
}

function toNormalized(
  raw: SmartRecruitersPosting,
  companySlug: string,
  descriptionText: string | null,
): NormalizedJob {
  const locationRaw = buildLocationString(raw.location);
  const externalId = String(raw.id);

  return {
    atsProvider: 'smartrecruiters',
    companySlug,
    companyName: nullifyBlank(raw.company?.name),
    externalId,
    title: raw.name.trim(),
    titleFingerprint: titleFingerprint(raw.name),
    department: nullifyBlank(raw.department?.label),
    team: nullifyBlank(raw.function?.label),
    employmentType: nullifyBlank(raw.typeOfEmployment?.label),
    locationRaw,
    locations: parseLocations(locationRaw),
    workplaceType: resolveWorkplace(raw.location),
    sourcePublishedAt: parseAtsDate(raw.releasedDate),
    sourceUpdatedAt: null,
    jobUrl: `https://jobs.smartrecruiters.com/${companySlug}/${externalId}`,
    applyUrl: `https://jobs.smartrecruiters.com/${companySlug}/${externalId}`,
    descriptionText,
  };
}

/** 상세 호출로 본문을 가져온다. 실패는 null 반환(치명적이지 않음). */
async function fetchDescription(
  ref: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const payload = await fetchJson(ref, { signal, retries: 1 });
    const parsed = SmartRecruitersDetailSchema.safeParse(payload);
    if (!parsed.success) return null;

    const sections = parsed.data.jobAd?.sections;
    if (!sections) return null;

    const text = Object.values(sections)
      .map((s) => nullifyBlank(s?.text))
      .filter((v): v is string => v !== null)
      .map(htmlToPlainText)
      .join('\n\n');

    return nullifyBlank(text);
  } catch {
    return null;
  }
}

export const smartRecruitersConnector: AtsConnector = {
  provider: 'smartrecruiters',

  boardUrl(companySlug: string): string {
    return `https://jobs.smartrecruiters.com/${encodeURIComponent(companySlug)}`;
  },

  async fetchJobs(
    companySlug: string,
    options: FetchJobsOptions = {},
  ): Promise<FetchJobsResult> {
    const startedAt = Date.now();
    const warnings: string[] = [];
    const rawPostings: SmartRecruitersPosting[] = [];
    let rawCount = 0;

    // --- 1단계: 목록 페이지네이션 ---
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      const url =
        `${BASE}/${encodeURIComponent(companySlug)}/postings` +
        `?limit=${PAGE_SIZE}&offset=${offset}`;

      let payload: unknown;
      try {
        payload = await fetchJson(url, { signal: options.signal });
      } catch (error) {
        // 첫 페이지 실패는 치명적, 이후 페이지 실패는 부분 결과를 살린다.
        if (page === 0) {
          throw new AtsFetchError(
            `SmartRecruiters 보드 조회 실패: ${companySlug}`,
            'smartrecruiters',
            companySlug,
            error,
            error instanceof HttpError ? error.status : undefined,
          );
        }
        warnings.push(`page ${page}(offset ${offset}) 조회 실패 — 부분 결과 사용`);
        break;
      }

      const parsed = SmartRecruitersListSchema.safeParse(payload);
      if (!parsed.success) {
        if (page === 0) {
          throw new AtsFetchError(
            `SmartRecruiters 응답 구조 변경 감지: ${companySlug} — ${parsed.error.issues[0]?.message}`,
            'smartrecruiters',
            companySlug,
            parsed.error,
          );
        }
        warnings.push(`page ${page} 구조 오류 — 부분 결과 사용`);
        break;
      }

      const batch = parsed.data.content;
      rawCount += batch.length;

      for (const [index, item] of batch.entries()) {
        const posting = SmartRecruitersPostingSchema.safeParse(item);
        if (!posting.success) {
          warnings.push(
            `job[${offset + index}] 정규화 실패: ${posting.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          );
          continue;
        }
        // 비공개 공고는 리드 신호로 쓸 수 없다.
        if (
          posting.data.visibility &&
          posting.data.visibility.toUpperCase() !== 'PUBLIC'
        ) {
          continue;
        }
        rawPostings.push(posting.data);
      }

      // 마지막 페이지 판정: 받은 개수가 페이지 크기보다 작으면 끝.
      if (batch.length < PAGE_SIZE) break;

      if (page === MAX_PAGES - 1) {
        warnings.push(
          `MAX_PAGES(${MAX_PAGES}) 도달 — ${companySlug}의 공고가 잘렸을 수 있음`,
        );
      }
    }

    // --- 2단계: 본문 보강 (옵션) ---
    const descriptions = new Map<string, string | null>();
    if (options.includeContent && rawPostings.length > 0) {
      const targets = rawPostings
        .filter((p) => nullifyBlank(p.ref))
        .slice(0, MAX_DETAIL_FETCHES);

      if (rawPostings.length > MAX_DETAIL_FETCHES) {
        warnings.push(
          `본문 보강을 상위 ${MAX_DETAIL_FETCHES}건으로 제한 (전체 ${rawPostings.length}건)`,
        );
      }

      const results = await mapWithConcurrency(targets, 4, async (posting) =>
        fetchDescription(posting.ref as string, options.signal),
      );

      results.forEach((result, i) => {
        const posting = targets[i];
        if (!posting) return;
        descriptions.set(
          String(posting.id),
          result.ok ? result.value : null,
        );
      });
    }

    const jobs = rawPostings.map((p) =>
      toNormalized(p, companySlug, descriptions.get(String(p.id)) ?? null),
    );

    if (rawCount === 0) {
      warnings.push(
        'EMPTY_BOARD: 공고 0건. 회사 식별자 오류 또는 실제 채용 없음 — 대소문자 구분 주의',
      );
    }

    return {
      provider: 'smartrecruiters',
      companySlug,
      jobs,
      warnings,
      rawCount,
      fetchedAt: new Date(),
      durationMs: Date.now() - startedAt,
    };
  },
};
