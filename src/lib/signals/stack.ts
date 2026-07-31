/**
 * 기술스택 추출.
 *
 * 설계 결정: LLM을 쓰지 않는다.
 *
 * 일일 스캔은 수만 건을 처리하므로 건당 LLM 호출은 원가 구조를 파괴한다.
 * ("원가 0원으로 시작해 첫 유저부터 순이익"이 이 사업의 핵심 전제다.)
 * 기술스택은 어휘가 닫혀 있는 도메인이라 사전 매칭으로 충분한 정밀도가 나온다.
 * LLM은 유료 기능(콜드메일 생성)에서만 쓴다.
 *
 * 정확도보다 재현율을 우선한다. 스택은 리드 필터링 축이므로
 * "React 프리랜서에게 React 공고가 안 잡히는 것"이 최악의 실패다.
 */

/** 스택 분류. 클러스터 신호(같은 계열 동시 채용)를 계산할 때 쓴다. */
export type StackCategory =
  | 'frontend'
  | 'backend'
  | 'mobile'
  | 'data'
  | 'infra'
  | 'design'
  | 'nocode'
  | 'language';

export interface StackTerm {
  /** 정규화된 태그명. DB에 저장되는 값. */
  tag: string;
  category: StackCategory;
  /**
   * 매칭할 표기 변형. 대소문자 무시.
   * 정규식 특수문자는 자동 이스케이프되므로 그대로 적으면 된다.
   */
  aliases: string[];
}

/**
 * 사전. 프리랜서 외주 시장에서 실제로 거래되는 스택에 집중한다.
 * COBOL·Fortran 같은 것은 프리랜서 리드가 아니라 노이즈다.
 */
const STACK_TERMS: StackTerm[] = [
  // ---- 언어 ----
  { tag: 'typescript', category: 'language', aliases: ['typescript', 'ts'] },
  { tag: 'javascript', category: 'language', aliases: ['javascript', 'js', 'ecmascript'] },
  { tag: 'python', category: 'language', aliases: ['python'] },
  { tag: 'go', category: 'language', aliases: ['golang', 'go lang'] },
  { tag: 'rust', category: 'language', aliases: ['rust'] },
  { tag: 'java', category: 'language', aliases: ['java'] },
  { tag: 'kotlin', category: 'language', aliases: ['kotlin'] },
  { tag: 'swift', category: 'language', aliases: ['swift', 'swiftui'] },
  { tag: 'ruby', category: 'language', aliases: ['ruby'] },
  { tag: 'php', category: 'language', aliases: ['php'] },
  { tag: 'csharp', category: 'language', aliases: ['c#', 'csharp', '.net', 'dotnet', 'asp.net'] },
  { tag: 'cpp', category: 'language', aliases: ['c++', 'cpp'] },
  { tag: 'elixir', category: 'language', aliases: ['elixir', 'phoenix framework'] },
  { tag: 'scala', category: 'language', aliases: ['scala'] },

  // ---- 프론트엔드 ----
  { tag: 'react', category: 'frontend', aliases: ['react', 'react.js', 'reactjs'] },
  { tag: 'nextjs', category: 'frontend', aliases: ['next.js', 'nextjs'] },
  { tag: 'vue', category: 'frontend', aliases: ['vue', 'vue.js', 'vuejs', 'nuxt', 'nuxt.js'] },
  { tag: 'angular', category: 'frontend', aliases: ['angular', 'angularjs'] },
  { tag: 'svelte', category: 'frontend', aliases: ['svelte', 'sveltekit'] },
  { tag: 'tailwind', category: 'frontend', aliases: ['tailwind', 'tailwindcss'] },
  { tag: 'webgl', category: 'frontend', aliases: ['webgl', 'three.js', 'threejs'] },

  // ---- 백엔드 ----
  { tag: 'nodejs', category: 'backend', aliases: ['node.js', 'nodejs', 'node js'] },
  { tag: 'django', category: 'backend', aliases: ['django'] },
  { tag: 'fastapi', category: 'backend', aliases: ['fastapi'] },
  { tag: 'flask', category: 'backend', aliases: ['flask'] },
  { tag: 'rails', category: 'backend', aliases: ['rails', 'ruby on rails'] },
  { tag: 'spring', category: 'backend', aliases: ['spring boot', 'springboot', 'spring framework'] },
  { tag: 'laravel', category: 'backend', aliases: ['laravel'] },
  { tag: 'graphql', category: 'backend', aliases: ['graphql', 'apollo server'] },
  { tag: 'grpc', category: 'backend', aliases: ['grpc'] },

  // ---- 모바일 ----
  { tag: 'react-native', category: 'mobile', aliases: ['react native', 'react-native'] },
  { tag: 'flutter', category: 'mobile', aliases: ['flutter', 'dart'] },
  { tag: 'ios', category: 'mobile', aliases: ['ios', 'objective-c', 'objective c'] },
  { tag: 'android', category: 'mobile', aliases: ['android', 'jetpack compose'] },

  // ---- 데이터 / AI ----
  { tag: 'sql', category: 'data', aliases: ['sql'] },
  { tag: 'postgres', category: 'data', aliases: ['postgres', 'postgresql'] },
  { tag: 'mysql', category: 'data', aliases: ['mysql', 'mariadb'] },
  { tag: 'mongodb', category: 'data', aliases: ['mongodb', 'mongo'] },
  { tag: 'redis', category: 'data', aliases: ['redis'] },
  { tag: 'snowflake', category: 'data', aliases: ['snowflake'] },
  { tag: 'bigquery', category: 'data', aliases: ['bigquery', 'big query'] },
  { tag: 'dbt', category: 'data', aliases: ['dbt'] },
  { tag: 'spark', category: 'data', aliases: ['spark', 'pyspark'] },
  { tag: 'airflow', category: 'data', aliases: ['airflow'] },
  { tag: 'pytorch', category: 'data', aliases: ['pytorch', 'torch'] },
  { tag: 'tensorflow', category: 'data', aliases: ['tensorflow', 'keras'] },
  { tag: 'llm', category: 'data', aliases: ['llm', 'large language model', 'openai api', 'rag', 'langchain', 'prompt engineering'] },

  // ---- 인프라 / DevOps ----
  { tag: 'aws', category: 'infra', aliases: ['aws', 'amazon web services'] },
  { tag: 'gcp', category: 'infra', aliases: ['gcp', 'google cloud'] },
  { tag: 'azure', category: 'infra', aliases: ['azure'] },
  { tag: 'kubernetes', category: 'infra', aliases: ['kubernetes', 'k8s', 'eks', 'gke'] },
  { tag: 'docker', category: 'infra', aliases: ['docker', 'containerization'] },
  { tag: 'terraform', category: 'infra', aliases: ['terraform', 'opentofu'] },
  { tag: 'kafka', category: 'infra', aliases: ['kafka'] },
  { tag: 'ci-cd', category: 'infra', aliases: ['ci/cd', 'github actions', 'circleci', 'jenkins'] },
  { tag: 'vercel', category: 'infra', aliases: ['vercel'] },
  { tag: 'supabase', category: 'infra', aliases: ['supabase'] },
  { tag: 'firebase', category: 'infra', aliases: ['firebase'] },

  // ---- 디자인 ----
  { tag: 'figma', category: 'design', aliases: ['figma'] },
  { tag: 'design-system', category: 'design', aliases: ['design system', 'design systems'] },
  { tag: 'ux-research', category: 'design', aliases: ['ux research', 'user research', 'usability testing'] },
  { tag: 'motion', category: 'design', aliases: ['after effects', 'motion design', 'lottie'] },
  { tag: 'webflow', category: 'design', aliases: ['webflow'] },

  // ---- 노코드 / 자동화 (자동화 컨설턴트 리드) ----
  { tag: 'zapier', category: 'nocode', aliases: ['zapier'] },
  { tag: 'make', category: 'nocode', aliases: ['make.com', 'integromat'] },
  { tag: 'n8n', category: 'nocode', aliases: ['n8n'] },
  { tag: 'airtable', category: 'nocode', aliases: ['airtable'] },
  { tag: 'hubspot', category: 'nocode', aliases: ['hubspot'] },
  { tag: 'salesforce', category: 'nocode', aliases: ['salesforce', 'apex trigger'] },
  { tag: 'shopify', category: 'nocode', aliases: ['shopify', 'shopify plus'] },
  { tag: 'stripe', category: 'nocode', aliases: ['stripe'] },
];

/** 정규식 특수문자 이스케이프. `c++`, `.net`, `ci/cd`, `c#` 때문에 필수. */
function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 경계 처리가 이 모듈의 핵심 난점이다.
 *
 * `\b`는 유니코드 단어문자 기준이라 `c++`나 `.net`처럼 비단어문자로
 * 시작/끝나는 별칭에서 오작동한다. 그래서 별칭의 양끝이 단어문자인지에 따라
 * 경계 패턴을 다르게 조립한다.
 *
 * 또한 `go`, `ts`, `js`, `ios` 같은 짧은 별칭은 오탐이 잦으므로
 * (예: "go to market"의 go) 별칭 길이가 2자 이하면 더 엄격한 경계를 쓴다.
 */
function buildPattern(aliases: string[]): RegExp {
  const parts = aliases.map((alias) => {
    const escaped = escapeRegex(alias);
    const startsWithWord = /^[\p{L}\p{N}]/u.test(alias);
    const endsWithWord = /[\p{L}\p{N}]$/u.test(alias);
    // 앞: 단어문자로 시작하면 앞에 단어문자가 오지 않아야 한다
    const prefix = startsWithWord ? '(?<![\\p{L}\\p{N}])' : '(?<![\\p{L}\\p{N}])';
    // 뒤: 단어문자로 끝나면 뒤에 단어문자/하이픈이 오지 않아야 한다.
    //     비단어문자로 끝나면(c++, .net) 뒤 경계를 강제하지 않는다.
    const suffix = endsWithWord ? '(?![\\p{L}\\p{N}])' : '';
    return `${prefix}${escaped}${suffix}`;
  });
  return new RegExp(parts.join('|'), 'giu');
}

interface CompiledTerm {
  tag: string;
  category: StackCategory;
  pattern: RegExp;
  /** 짧은 별칭만 가진 항목은 오탐 위험이 높아 최소 등장 횟수를 요구한다. */
  minHits: number;
}

const COMPILED: CompiledTerm[] = STACK_TERMS.map((term) => {
  const shortestAlias = Math.min(...term.aliases.map((a) => a.length));
  return {
    tag: term.tag,
    category: term.category,
    pattern: buildPattern(term.aliases),
    // "go", "ts", "js" 같은 2자 별칭은 1회 등장만으로 신뢰하지 않는다.
    minHits: shortestAlias <= 2 ? 2 : 1,
  };
});

export interface StackHit {
  tag: string;
  category: StackCategory;
  hits: number;
}

/**
 * 회사 자신의 이름과 같은 태그는 제외한다.
 *
 * 실측으로 드러난 버그: Stripe 공고 540건 전부에 `stripe` 태그가 붙었다.
 * 자사 소개 문구("Stripe is...")가 스택 매칭에 걸린 것이다. 이 오염은
 * 클러스터 신호까지 왜곡한다 — 모든 공고가 같은 태그를 공유하니 클러스터
 * 크기가 항상 전체 공고 수가 된다.
 *
 * 사전에 제품명으로 등록된 회사들(stripe, shopify, figma, linear, ramp,
 * supabase, vercel, airtable, hubspot, salesforce...)에서 모두 발생한다.
 */
/**
 * 사명에 흔히 붙는 접미사. `supabaseinc`, `ashbyhq` 같은 슬러그를 제품명과 잇는다.
 */
const COMPANY_SUFFIXES = [
  'inc', 'hq', 'io', 'ai', 'app', 'labs', 'lab', 'dev', 'cloud', 'data',
  'tech', 'co', 'com', 'corp', 'hr',
];

function companySelfTags(companySlug: string | undefined): Set<string> {
  if (!companySlug) return new Set();
  const slug = companySlug.toLowerCase().replace(/[^a-z0-9]/g, '');
  const self = new Set<string>();

  for (const tag of KNOWN_TAGS) {
    const normalizedTag = tag.replace(/[^a-z0-9]/g, '');
    if (normalizedTag.length < 3) continue;

    // 정확히 일치하거나, 사명 접미사만 덧붙은 경우만 자사 언급으로 본다.
    //
    // 부분 문자열 포함(`slug.includes(tag)`)은 쓰지 않는다. 그렇게 하면 사명에
    // 기술명이 들어간 회사가 그 태그를 통째로 잃는다 — "reactor-labs" 가
    // `react` 태그를 잃는 식이다. 리드가 조용히 누락되는 경로이고, 오탐보다
    // 이쪽이 더 비싸다.
    //
    // 이 판정이 놓치는 자사 언급은 detectBoardWideTags 가 통계적으로 걸러낸다
    // (보드 내 40% 초과 등장 태그 제외). 두 장치가 서로를 보완한다.
    const matches =
      slug === normalizedTag ||
      COMPANY_SUFFIXES.some((suffix) => slug === normalizedTag + suffix);

    if (matches) self.add(tag);
  }
  return self;
}

/**
 * 본문에서 기술스택을 추출한다.
 * 반환 순서는 등장 횟수 내림차순 → 태그명 오름차순(결정적 출력).
 *
 * `companySlug`를 넘기면 자사명 유래 태그를 제외한다. 반드시 넘기는 것을 권한다.
 */
export function extractTechStackDetailed(
  text: string | null | undefined,
  companySlug?: string,
): StackHit[] {
  if (!text) return [];
  const excluded = companySelfTags(companySlug);

  // 매우 긴 본문은 앞부분에 요건이 몰려 있다. 성능 보호를 위해 상한을 둔다.
  const haystack = text.length > 20_000 ? text.slice(0, 20_000) : text;

  const results: StackHit[] = [];
  for (const term of COMPILED) {
    if (excluded.has(term.tag)) continue;
    // 전역 정규식은 lastIndex 상태를 가지므로 매번 초기화한다.
    term.pattern.lastIndex = 0;
    const matches = haystack.match(term.pattern);
    const hits = matches?.length ?? 0;
    if (hits >= term.minHits) {
      results.push({ tag: term.tag, category: term.category, hits });
    }
  }

  return results.sort((a, b) => b.hits - a.hits || a.tag.localeCompare(b.tag));
}

/** 태그명만 필요한 경우의 간편 버전. */
export function extractTechStack(
  text: string | null | undefined,
  companySlug?: string,
): string[] {
  return extractTechStackDetailed(text, companySlug).map((h) => h.tag);
}

/**
 * 보드 전체에 퍼져 있는 태그를 찾아낸다. 클러스터 계산에서 제외할 대상이다.
 *
 * 실측 문제: Databricks 802건 중 `spark`가 511건(64%)에 등장했다. Spark는
 * Databricks의 주력 제품이라 거의 모든 공고의 회사 소개에 나온다. 슬러그 비교
 * (`databricks` vs `spark`)로는 잡히지 않는다.
 *
 * 일반해: 보드 내 출현율이 임계를 넘는 태그는 "그 회사의 배경 설명"이지
 * "특정 자리의 요구 기술"이 아니다. 클러스터 신호는 비정상적 집중을 찾는 것이므로
 * 모든 공고에 있는 태그는 정의상 신호가 될 수 없다.
 *
 * 이 방식은 회사별 하드코딩 없이 Stripe/Shopify/Figma/Databricks 모두를 처리한다.
 */
export function detectBoardWideTags(
  tagLists: Iterable<readonly string[]>,
  jobCount: number,
  threshold = 0.4,
): Set<string> {
  if (jobCount <= 0) return new Set();

  const counts = new Map<string, number>();
  for (const tags of tagLists) {
    for (const tag of new Set(tags)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  const boardWide = new Set<string>();
  for (const [tag, count] of counts) {
    if (count / jobCount > threshold) boardWide.add(tag);
  }
  return boardWide;
}

/**
 * 클러스터 신호용 카테고리 집계.
 * "같은 회사가 frontend 계열 4건을 동시 채용" 같은 판정에 쓴다.
 */
export function categorize(tags: readonly string[]): Map<StackCategory, string[]> {
  const byCategory = new Map<StackCategory, string[]>();
  const lookup = new Map(STACK_TERMS.map((t) => [t.tag, t.category]));

  for (const tag of tags) {
    const category = lookup.get(tag);
    if (!category) continue;
    const list = byCategory.get(category) ?? [];
    list.push(tag);
    byCategory.set(category, list);
  }
  return byCategory;
}

export const KNOWN_TAGS: readonly string[] = STACK_TERMS.map((t) => t.tag);
