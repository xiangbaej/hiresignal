/**
 * 직무 수임 가능성(addressability) 판정.
 *
 * ── 왜 필요한가 ──
 *
 * 스코어링은 "이 공고가 얼마나 막혀 있는가"를 측정한다. 하지만 막혀 있다는 것과
 * 프리랜서가 수임할 수 있다는 것은 전혀 다른 축이다.
 *
 * 실측 문제: 아카이브 보강 후 상위 리드에 이런 것들이 올라왔다.
 *   - "Account Executive - AI Native: Startups"  (1318일)
 *   - "Product Support Specialist, Pacific/Mountain" (453일)
 *   - "Customer Activation Manager | Mid-Market" (868일)
 *   - "Analytics Engineering Advocate - Europe" (831일)
 *
 * 전부 정확한 신호다 — 실제로 오래 막혀 있다. 그러나 프리랜서 개발자가 영업사원
 * 자리를 대신할 수는 없다. 이 리드를 받은 유저는 아무것도 할 수 없고, 그건 곧
 * 이탈이다. 정밀도가 재현율보다 중요한 지점이다.
 *
 * 따라서 addressability는 점수 신호가 아니라 **게이트**로 다룬다. 점수는 막힘의
 * 정도를 그대로 보고하고, 수임 불가 직무는 리드 목록에서 제외한다.
 *
 * ── 판정 순서가 중요하다 ──
 *
 * "Sales Engineer"는 sales가 아니라 engineering 인접이고, "Engineering Manager"는
 * engineering이지만 프리랜서가 대체할 수 없는 관리직이다. 그래서 배타 규칙
 * (리더십/영업)을 먼저 적용하고 그 다음에 직군을 본다.
 */

export type RoleCategory =
  | 'engineering'
  | 'design'
  | 'data'
  | 'infra'
  | 'content'
  | 'product'
  | 'sales'
  | 'support'
  | 'people'
  | 'finance_legal'
  | 'leadership'
  | 'other';

/** 프리랜서·1인 에이전시가 실제로 수임 가능한 직군 */
const ADDRESSABLE: ReadonlySet<RoleCategory> = new Set<RoleCategory>([
  'engineering',
  'design',
  'data',
  'infra',
  'content',
]);

/**
 * 리더십/정규직 전제 직책.
 *
 * 관리직은 조직 내 상시 권한이 필요해 외주로 대체되지 않는다. 프랙셔널 CTO 같은
 * 예외가 있지만 그건 별개 시장이고, 그런 수요는 채용 공고로 표현되지 않는다.
 */
/**
 * 리더십 표기.
 *
 * `lead` 처리에 주의가 필요하다. "Engineering Lead"는 팀 소유권을 가진 관리직이지만
 * "Lead Software Engineer"는 보통 시니어 개별 기여자다. 전자만 걸러야 한다.
 * 그래서 `lead`는 수식어가 앞에 오는 형태(`engineering lead`)나 제목 끝에
 * 단독으로 오는 형태만 리더십으로 본다.
 */
const LEADERSHIP_RE = new RegExp(
  [
    '\\b(?:vp|vice president|chief|c[tefiop]o|head of|director|managing)\\b',
    '\\bmanager\\b',
    '\\bleadership\\b',
    '\\bprincipal architect\\b',
    // "Engineering Lead", "Tech Lead", "Design Lead" 등
    '\\b(?:team|tech|technical|engineering|eng|design|data|product|project|program|ops)\\s+lead\\b',
    // 제목이 "... Lead"로 끝나는 경우
    '\\blead\\s*$',
  ].join('|'),
  'i',
);

/**
 * "Manager"가 들어가도 관리직이 아닌 경우를 구제한다.
 * 예: "Product Manager"는 관리직 표기가 아니라 직군명이다(그래도 수임 불가지만
 * leadership이 아니라 product로 분류하는 것이 정확하다).
 */
const MANAGER_EXCEPTIONS_RE = /\bproduct manager\b|\bprogram manager\b|\bproject manager\b/i;

const SALES_RE =
  /\b(account executive|\bae\b|sdr|bdr|sales development|business development|account manager|revenue|quota|enterprise sales|inside sales|partnerships?|channel|pre-?sales|solutions? (?:architect|consultant|engineer)|customer activation|growth marketer)\b/i;

/**
 * 고객지원 직군.
 *
 * `advocate` / `evangelist`를 여기서 빼고 content로 옮겼다. Developer Advocate와
 * DevRel은 실제로 프리랜서·계약 형태가 흔한 시장이다(콘텐츠 제작, 튜토리얼,
 * 컨퍼런스 발표). 반면 Customer Advocate는 지원 직군이므로, `advocate` 단독이
 * 아니라 앞에 오는 수식어로 구분한다.
 *
 * 실측 근거: 이 규칙 때문에 content 직군 리드가 3건까지 줄었다.
 */
const SUPPORT_RE =
  /\b(customer (?:success|support|experience|activation|advocate)|technical account|support (?:engineer|specialist|manager)|onboarding specialist|implementation (?:specialist|consultant)|community manager|solutions? specialist)\b/i;

const PEOPLE_RE =
  /\b(recruit(?:er|ing)|talent|people ops|human resources|\bhr\b|sourcer|compensation|benefits)\b/i;

const FINANCE_LEGAL_RE =
  /\b(accountant|accounting|controller|payroll|tax|treasury|audit|legal counsel|counsel|paralegal|compliance officer|risk analyst|underwrit)/i;

// `engineer(?:ing)?`로 써야 "Software Engineering", "Engineering Lead" 같은
// 형용사형 표기를 놓치지 않는다. `\bengineer\b`만 쓰면 뒤에 'ing'가 붙는 순간
// 단어 경계가 깨져 매칭에 실패한다 — 실측에서 "Engineering Lead"가 미분류로 빠졌다.
const ENGINEERING_RE =
  /\b(software engineer(?:ing)?|engineer(?:ing)?|developer|programmer|sre|site reliability|backend|back-?end|frontend|front-?end|full-?stack|fullstack|mobile|ios|android|firmware|embedded|compiler|kernel|systems? engineer(?:ing)?|member of technical staff|mts|swe)\b/i;

const INFRA_RE =
  /\b(devops|platform engineer|infrastructure|cloud engineer|security engineer|sre|site reliability|network engineer|systems administrator|observability)\b/i;

const DATA_RE =
  /\b(data (?:engineer|scientist|analyst)|machine learning|\bml\b|mlops|analytics engineer|research (?:scientist|engineer)|ai (?:engineer|scientist)|applied scientist|nlp|computer vision)\b/i;

const DESIGN_RE =
  /\b(designer|design engineer|\bux\b|\bui\b|user experience|user research|brand|visual|motion|illustrat|creative)\b/i;

/**
 * 콘텐츠/DevRel 직군.
 *
 * 프리랜서 시장이 실재하는 영역이다 — 문서 작성, 튜토리얼, 샘플 코드, 컨퍼런스
 * 발표는 프로젝트 단위로 외주가 나간다. Developer Advocate / Evangelist는
 * 지원 직군이 아니라 여기에 속한다.
 */
const CONTENT_RE =
  /\b(technical writer|technical writing|documentation|docs engineer|content (?:writer|designer|strategist|marketer|manager|lead)|copywriter|editor|developer (?:advocate|advocacy|relations|educator|experience)|devrel|\bdx\b engineer|community (?:engineer|advocate)|(?:developer|technical|product) (?:evangelist|advocate)|curriculum|instructional design)\b/i;

const PRODUCT_RE = /\b(product manager|product owner|program manager|project manager|chief of staff|strategy|operations? (?:manager|analyst|associate))\b/i;

const INTERN_RE =
  /\b(intern|internship|new grad|new-grad|early career|apprentice|co-?op|university (?:hire|program)|graduate program|working student|werkstudent)\b/i;

export interface RoleVerdict {
  category: RoleCategory;
  /** 프리랜서·1인 에이전시가 수임 가능한가 */
  addressable: boolean;
  /** 판정 근거 (디버깅·UI 노출용) */
  reason: string;
}

/**
 * 제목과 부서명으로 직무를 분류한다.
 *
 * 본문은 쓰지 않는다. 본문에는 회사 소개·복리후생이 섞여 있어 오탐이 심하다
 * (실측: 계약 의도 탐지 시 'part-time' 364건이 전부 복리후생 문구였다).
 */
export function classifyRole(
  title: string,
  department?: string | null,
): RoleVerdict {
  const t = title.trim();
  const haystack = department ? `${t} ${department}` : t;

  // --- 0) 인턴/신입 프로그램 ---
  //
  // 외주 발주 의도와 무관하다. 회사가 인턴을 못 구하는 것은 프리랜서 기회가 아니다.
  // 실측에서 'other'로 빠진 제외 샘플의 절반이 인턴 공고였다.
  if (INTERN_RE.test(t)) {
    return {
      category: 'other',
      addressable: false,
      reason: '인턴/신입 프로그램 — 외주 발주 의도와 무관',
    };
  }

  // --- 1) 배타 규칙 먼저 ---
  //
  // "Sales Engineer", "Engineering Manager"처럼 직군어와 배타어가 함께 있는
  // 경우를 올바르게 처리하기 위한 순서다.

  if (LEADERSHIP_RE.test(t) && !MANAGER_EXCEPTIONS_RE.test(t)) {
    return {
      category: 'leadership',
      addressable: false,
      reason: '관리직/임원 — 조직 내 상시 권한이 필요해 외주 대체 불가',
    };
  }

  if (SALES_RE.test(haystack)) {
    return {
      category: 'sales',
      addressable: false,
      reason: '영업 직군 — 프리랜서 개발/디자인으로 수임 불가',
    };
  }

  if (SUPPORT_RE.test(haystack)) {
    return {
      category: 'support',
      addressable: false,
      reason: '고객지원/CS 직군 — 상시 대응이 필요해 프로젝트 외주로 전환되지 않음',
    };
  }

  if (PEOPLE_RE.test(haystack)) {
    return {
      category: 'people',
      addressable: false,
      reason: '채용/인사 직군',
    };
  }

  if (FINANCE_LEGAL_RE.test(haystack)) {
    return {
      category: 'finance_legal',
      addressable: false,
      reason: '재무/법무 직군',
    };
  }

  // --- 2) 수임 가능 직군 ---
  //
  // 순서 주의: infra와 data는 engineering과 겹치므로 더 구체적인 쪽을 먼저 본다.
  // "Security Engineer"는 engineering보다 infra로 분류하는 것이 매칭 정확도를 높인다.

  if (INFRA_RE.test(haystack)) {
    return { category: 'infra', addressable: true, reason: '인프라/DevOps/보안' };
  }
  if (DATA_RE.test(haystack)) {
    return { category: 'data', addressable: true, reason: '데이터/ML' };
  }
  if (DESIGN_RE.test(haystack)) {
    return { category: 'design', addressable: true, reason: '디자인' };
  }
  if (CONTENT_RE.test(haystack)) {
    return {
      category: 'content',
      addressable: true,
      reason: '테크니컬 라이팅/콘텐츠',
    };
  }
  if (ENGINEERING_RE.test(haystack)) {
    return { category: 'engineering', addressable: true, reason: '개발' };
  }

  // --- 3) 나머지 ---
  if (PRODUCT_RE.test(haystack)) {
    return {
      category: 'product',
      addressable: false,
      reason: '프로덕트/기획 직군 — 조직 내부 맥락 의존도가 높음',
    };
  }

  return {
    category: 'other',
    addressable: false,
    reason: '분류 불가 — 수임 가능성을 보수적으로 판단',
  };
}

export function isAddressable(category: RoleCategory): boolean {
  return ADDRESSABLE.has(category);
}
