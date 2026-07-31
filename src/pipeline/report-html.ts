/**
 * HTML 리포트 생성.
 *
 *   npx tsx src/pipeline/report-html.ts
 *   → data/report.html   내부용 전체 리드
 *   → docs/index.html    공개용 티저 (GitHub Pages)
 *
 * ── 왜 필요한가 ──
 *
 * data/leads.json 은 기계가 읽는 형식이라 사람에게 보여줄 수 없고, 보여줄 수 없으면
 * 검증도 판매도 불가능하다. 이 사업의 다음 관문은 기술이 아니라 "프리랜서가 이
 * 리드에 돈을 낼 것인가"이고, 그 대화에 필요한 최소 산출물이 이것이다.
 *
 * 의존성을 추가하지 않는다. 단일 HTML 파일로 만들어 이메일 첨부·정적 호스팅·로컬
 * 열기가 모두 되게 한다. 이후 웹앱으로 갈 때 이 화면이 명세가 된다.
 *
 * 공고 본문은 담지 않는다. ATS 의 job board API 는 자사 채용 페이지 구축을 목적으로
 * 제공된 것이므로 본문을 재배포하지 않고 원문 링크로 보낸다. 우리가 파는 것은 본문이
 * 아니라 "어느 공고가 왜 기회인가"라는 판단이다.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { categorize, type StackCategory } from '../lib/signals/stack.js';
import { roleKey, splitTitleRegion } from '../lib/title-variant.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_DIR = path.join(ROOT, 'data');

const REPO_URL = 'https://github.com/xiangbaej/hiresignal';

/** 공개 페이지에서 무료로 보여줄 리드 수 */
const PUBLIC_PREVIEW_COUNT = 20;

interface Lead {
  rel: number;
  score: number;
  grade: string;
  signals: number;
  confidence: number;
  ageDays: number | null;
  ageFromArchive: boolean;
  company: string;
  board: string;
  title: string;
  jobUrl: string;
  workplaceType: string;
  locationRaw: string | null;
  roleCategory: string;
  tags: string[];
  reasons: string[];
}

interface LeadsFile {
  generatedAt: string;
  runId: string;
  summary: {
    total: number;
    hot: number;
    warm: number;
    withArchiveEvidence: number;
    byRole: Record<string, number>;
    droppedByRole: number;
    droppedByCategory: Record<string, number>;
    /** 직군 필터가 제외한 공고 제목 샘플. 필터 정밀도 감사용. */
    droppedSamples?: Record<string, string[]>;
  };
  leads: Lead[];
}

/**
 * 회사 단위 묶음.
 *
 * ── 왜 필요한가 ──
 *
 * 프리랜서는 공고에 지원하는 게 아니라 회사에 제안한다. 같은 회사의 세 자리가
 * 따로 흩어져 있으면 "이 회사가 인프라 인력을 못 뽑고 있다"는 그림이 보이지 않고,
 * 같은 회사에 세 번 콜드메일을 보내는 실수도 유발한다.
 *
 * 집중도 자체가 우리 스코어링의 신호이기도 하다(cluster). 그 신호를 화면에서
 * 다시 흩어놓으면 계산한 의미가 없다.
 */
interface CompanyGroup {
  company: string;
  board: string;
  count: number;
  hotCount: number;
  maxAge: number | null;
  /** 소속 리드의 최고 relativeScore. 정렬 기준. */
  topRel: number;
  tabGroups: Set<string>;
  tags: string[];
  searchBlob: string;
  /** 서로 다른 직무 수. count(공고 수)보다 작으면 중복이 접힌 것이다. */
  roleCount: number;
  roles: RoleEntry[];
}

/** 접힌 직무 하나에 딸린 개별 공고 = "자리" */
interface RoleSeat {
  /**
   * 공고 원문 제목. 지역을 뗀 base 와 별도로 들고 있는다.
   *
   * 자리가 하나뿐인 지역 변형(예: `... Backend (Bucharest)`)에서 base 만 쓰면
   * 화면에서 지역이 사라져 원문과 다른 제목이 보인다. 접기는 중복을 줄이려는
   * 것이고 원문을 바꾸려는 게 아니다.
   */
  title: string;
  jobUrl: string;
  ageDays: number | null;
  ageFromArchive: boolean;
  grade: string;
  /** 지역 변형에서 떼어낸 지역 라벨. 제목이 완전히 같아서 묶인 경우 null. */
  region: string | null;
}

/**
 * 같은 직무로 묶인 자리들.
 *
 * ── 왜 접는가 ──
 *
 * cresta 의 `Infrastructure Engineer/SRE` 는 305일·157일·157일 세 건이 각각
 * 올라와 있다. 세 줄로 나열하면 "직무가 세 개"로 읽히지만 실제로는 **한 직무에
 * 자리가 세 개**다. 이 구분은 콜드메일 논지를 바꾼다 — 전자는 "여러 분야를
 * 못 뽑는다", 후자는 "이 한 자리를 세 번 시도하고도 못 뽑았다"이고 후자가 훨씬
 * 강한 근거다. 화면에서 흩어놓으면 그 사실이 보이지 않는다.
 *
 * 접어도 개별 공고 링크는 전부 남긴다. 근거를 확인할 수 없는 요약은 이 리포트에서
 * 가치가 없다.
 */
interface RoleEntry {
  /** 대표 제목. 지역 변형이면 지역을 뗀 본문. */
  title: string;
  /** 소속 자리 중 최장 경과일 */
  maxAge: number | null;
  /** 최장 경과일 자리의 아카이브 증거 유무 */
  ageFromArchive: boolean;
  grade: string;
  tags: string[];
  seats: RoleSeat[];
}

// 제목 변형 판정(지역 어휘·정규화)은 src/lib/title-variant.ts 에 있다.
// 감사 스크립트(roles:audit)가 같은 로직을 써야 하는데 이 파일은 import 시점에
// main() 이 돌아 리포트를 써버리므로 재사용할 수 없다.

/** 리드를 회사 단위로 묶는다. 보드가 다르면 다른 회사로 취급한다. */
function groupByCompany(leads: Lead[]): CompanyGroup[] {
  const map = new Map<string, CompanyGroup>();
  // 회사별 직무 묶음. CompanyGroup 에 직접 담지 않는 이유는 정규화 키가 화면에
  // 나갈 값이 아니기 때문이다.
  const roleMaps = new Map<string, Map<string, RoleEntry>>();

  for (const lead of leads) {
    const key = lead.board || lead.company;
    let g = map.get(key);
    if (!g) {
      g = {
        company: lead.company,
        board: lead.board,
        count: 0,
        hotCount: 0,
        maxAge: null,
        topRel: 0,
        tabGroups: new Set(),
        tags: [],
        searchBlob: '',
        roleCount: 0,
        roles: [],
      };
      map.set(key, g);
      roleMaps.set(key, new Map());
    }

    g.count++;
    if (lead.grade === 'hot') g.hotCount++;
    if (lead.ageDays !== null) {
      g.maxAge = g.maxAge === null ? lead.ageDays : Math.max(g.maxAge, lead.ageDays);
    }
    g.topRel = Math.max(g.topRel, lead.rel);
    g.tabGroups.add(tabGroupOf(lead));
    for (const tag of lead.tags) {
      if (!g.tags.includes(tag)) g.tags.push(tag);
    }

    // 같은 직무의 자리를 하나로 접는다. 지역만 다른 변형도 같은 직무로 본다.
    const { base, region } = splitTitleRegion(lead.title);
    const roleMap = roleMaps.get(key)!;
    const rk = roleKey(base);
    let entry = roleMap.get(rk);
    if (!entry) {
      entry = {
        title: base,
        maxAge: null,
        ageFromArchive: false,
        grade: lead.grade,
        tags: [],
        seats: [],
      };
      roleMap.set(rk, entry);
    }
    entry.seats.push({
      title: lead.title,
      jobUrl: lead.jobUrl,
      ageDays: lead.ageDays,
      ageFromArchive: lead.ageFromArchive,
      grade: lead.grade,
      region,
    });
    // 대표값은 가장 오래 막힌 자리에서 가져온다. 그 자리가 제안의 근거가 된다.
    if (lead.ageDays !== null && (entry.maxAge === null || lead.ageDays > entry.maxAge)) {
      entry.maxAge = lead.ageDays;
      entry.ageFromArchive = lead.ageFromArchive;
      entry.grade = lead.grade;
    }
    for (const tag of lead.tags) {
      if (!entry.tags.includes(tag)) entry.tags.push(tag);
    }
  }

  for (const [key, g] of map) {
    g.roles = [...roleMaps.get(key)!.values()];
    g.roleCount = g.roles.length;

    // 오래 막힌 자리를 먼저 보여준다. 제안 각도를 잡을 때 그게 시작점이다.
    g.roles.sort((a, b) => (b.maxAge ?? -1) - (a.maxAge ?? -1));
    for (const r of g.roles) {
      r.seats.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
    }

    // 검색 대상에는 지역 라벨도 넣는다. 접기로 제목에서 지역이 빠졌으므로
    // 넣지 않으면 "Canada" 검색이 조용히 실패한다.
    const titleBlob = g.roles
      .map((r) => `${r.title} ${r.seats.map((s) => s.region ?? '').join(' ')}`)
      .join(' ');
    // 보드 문자열도 넣는다. 카드에 `greenhouse:cresta` 가 보이는데 그걸로 검색하면
    // 결과가 없는 것은 화면과 검색이 어긋난 것이다.
    g.searchBlob = `${g.company} ${g.board} ${titleBlob} ${g.tags.join(' ')}`
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  // 자리 수가 많은 회사가 먼저. 같으면 더 오래 막힌 쪽.
  return [...map.values()].sort(
    (a, b) => b.count - a.count || (b.maxAge ?? -1) - (a.maxAge ?? -1),
  );
}

/* ================================================================== *
 * 안전 처리
 * ================================================================== */

/** XSS 방지. 공고 제목·회사명은 외부 입력이므로 반드시 이스케이프한다. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** URL 은 이스케이프만으로 부족하다. javascript: 스킴 등을 차단한다. */
function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '#';
    return esc(url.toString());
  } catch {
    return '#';
  }
}

const ROLE_LABELS: Record<string, string> = {
  engineering: '개발',
  infra: '인프라',
  data: '데이터/ML',
  design: '디자인',
  content: '콘텐츠/DevRel',
};

/* ================================================================== *
 * 탭 그룹 분류
 * ================================================================== */

/**
 * 카테고리 탭용 그룹. 각 리드는 정확히 하나의 그룹에 속한다.
 *
 * 하나만 배정하는 이유: 탭에 개수를 표시하는데 중복 배정하면 합이 전체와 맞지 않아
 * 사용자가 데이터를 의심하게 된다. 다중 스택 공고는 대표 그룹으로 수렴시킨다.
 */
type TabGroup = 'ai' | 'frontend' | 'backend' | 'infra' | 'data' | 'design' | 'etc';

const TAB_LABELS: Array<{ key: TabGroup | 'all'; label: string }> = [
  { key: 'all', label: '전체' },
  { key: 'ai', label: 'AI·LLM' },
  { key: 'frontend', label: '프론트엔드' },
  { key: 'backend', label: '백엔드' },
  { key: 'infra', label: '인프라' },
  { key: 'data', label: '데이터' },
  { key: 'design', label: '디자인' },
  { key: 'etc', label: '기타' },
];

/**
 * AI 계열 태그.
 *
 * 이것만 별도로 둔다. stack.ts 에서 이들은 `data` 카테고리에 속하는데, 외주 시장에서
 * LLM 수요는 일반 데이터 업무와 뚜렷하게 구분되므로 탭에서는 분리해야 한다.
 * 즉 분류 축이 다른 것이지 중복 정의가 아니다.
 */
const AI_TAGS = new Set(['llm', 'pytorch', 'tensorflow']);

/**
 * 리드를 탭 그룹에 배정한다.
 *
 * 스택 태그의 카테고리는 `stack.ts` 의 `categorize()` 에서 가져온다. 여기에 태그
 * 목록을 다시 적으면 stack.ts 에 태그가 추가될 때 탭 분류가 조용히 놓친다 — 사전을
 * 두 곳에서 관리하면 반드시 어긋난다.
 *
 * 판정 순서가 중요하다. AI 를 최우선으로 두는 이유는 그 수요가 가장 뚜렷하게
 * 구분되기 때문이고, 그 다음은 직군 분류(roleCategory)를 신뢰한다. 스택 태그는 직군
 * 안에서 프론트/백엔드를 가르는 데만 쓴다 — 태그를 먼저 보면 "k8s 를 쓰는 프론트엔드
 * 개발자"가 인프라로 분류된다.
 */
function tabGroupOf(lead: Lead): TabGroup {
  if (lead.tags.some((t) => AI_TAGS.has(t))) return 'ai';

  const categories = categorize(lead.tags);
  const has = (c: StackCategory) => categories.has(c);

  switch (lead.roleCategory) {
    case 'infra':
      return 'infra';
    case 'data':
      return 'data';
    case 'design':
      return 'design';
    case 'engineering':
      // mobile 은 프론트엔드 탭으로 합친다. 탭을 8개 이상 늘리면 선택 비용이
      // 커지고, 프리랜서 시장에서 웹/모바일 프론트엔드는 인접 수요다.
      if (has('frontend') || has('mobile')) return 'frontend';
      if (has('infra')) return 'infra';
      if (has('data')) return 'data';
      return 'backend';
    default:
      return 'etc';
  }
}

/* ================================================================== *
 * 공통 디자인 토큰
 * ================================================================== */

/**
 * 밝은 배경 + 흰 카드 + 얇은 그림자로 구획을 만든다.
 *
 * 실선 테두리를 쓰지 않는 이유: 카드가 수백 개 쌓일 때 선이 격자처럼 보여 시선을
 * 잡아먹는다. 배경색 차이와 여백만으로 구획이 충분히 읽힌다.
 */
const DESIGN_TOKENS = `
  :root {
    --bg: #f2f4f6;
    --card: #ffffff;
    --fg: #191f28;
    --fg2: #4e5968;
    --muted: #8b95a1;
    --primary: #3182f6;
    --primary-dark: #1b64da;
    --primary-weak: #e8f3ff;
    --primary-weak2: #d8ebff;
    --hot: #f04452;
    --hot-weak: #ffeceb;
    --warn: #ff9500;
    --warn-weak: #fff4e6;
    --warn-fg: #b26a00;
    /* 경계선·칩·호버. 하드코딩된 hex 를 토큰으로 뺀 이유는 다크 모드에서
       이 값들만 갈아끼우면 되게 하려는 것이다. */
    --line: #eef1f4;
    --line-strong: #e9ecef;
    --hover: #e8ebee;
    --chip-bg: #fafbfc;
    --chip-line: #e3e7ec;
    --dup-bg: #fdecea;
    --dup-fg: #b3261e;
    /* 솔리드 배경 위에 얹는 글자색.
       흰색을 직접 쓰면 다크 모드에서 --fg / --primary / --hot 이 밝아질 때
       밝은 배경에 흰 글자가 되어 읽히지 않는다. 배경별로 토큰을 나눠 둔다. */
    --on-fg: #ffffff;
    --on-primary: #ffffff;
    --on-hot: #ffffff;
    --radius: 20px;
    --shadow: 0 1px 2px rgba(0, 27, 55, .04), 0 6px 20px rgba(0, 27, 55, .05);
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }

  /*
   * hidden 속성을 저자 스타일보다 우선시킨다.
   *
   * 왜 !important 인가: 저자 스타일은 명시도와 무관하게 UA 스타일을 항상 이긴다.
   * .feed 가 display:grid 를 지정하는 순간 UA 의 [hidden]{display:none} 이 무력해져
   * 숨긴 피드가 그대로 렌더링된다. 실제로 이 결함으로 회사 카드 98개와 공고 카드
   * 457개가 동시에 한 열에 쌓여 있었다. display 를 지정하는 요소에 hidden 을 쓰는
   * 조합은 앞으로도 생기므로 개별 규칙이 아니라 여기서 한 번에 막는다.
   */
  [hidden] { display: none !important; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Pretendard", "Apple SD Gothic Neo",
          "Malgun Gothic", "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--primary); }
  .sig {
    font-size: 13px; font-weight: 700; border-radius: 999px; padding: 6px 12px;
    letter-spacing: -.01em; white-space: nowrap;
  }
  .sig-hot { background: var(--hot-weak); color: var(--hot); }
  .sig-warn { background: var(--warn-weak); color: var(--warn-fg); }
  .sig-calm { background: var(--bg); color: var(--fg2); }
  .sig-none { background: var(--bg); color: var(--muted); font-weight: 600; }
  .sig abbr { text-decoration: none; }
  .grade {
    font-size: 11px; font-weight: 800; text-transform: uppercase;
    letter-spacing: .04em; padding: 4px 9px; border-radius: 6px;
  }
  .grade-hot { background: var(--hot); color: var(--on-hot); }
  .grade-warm { background: var(--warn-weak); color: var(--warn-fg); }
  .company { font-size: 15px; font-weight: 600; color: var(--fg2); margin-bottom: 2px; }
  .title {
    font-size: 21px; font-weight: 800; letter-spacing: -.025em;
    margin: 0 0 12px; line-height: 1.35;
  }
  .title a { color: var(--fg); text-decoration: none; }
  .title a:hover { color: var(--primary); }
  .tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .tag {
    font-size: 12px; font-weight: 600; color: var(--fg2); background: var(--bg);
    border-radius: 7px; padding: 4px 9px;
  }
  .meta { font-size: 12.5px; color: var(--muted); }
  .why { margin-top: 14px; }
  .why summary {
    cursor: pointer; font-size: 13px; font-weight: 600; color: var(--primary);
    list-style: none; display: inline-block;
  }
  .why summary::-webkit-details-marker { display: none; }
  .why summary::after { content: " \\203A"; }
  .why[open] summary::after { content: " \\2304"; }
  .why ul {
    margin: 10px 0 0; padding: 14px 16px 14px 32px; background: var(--bg);
    border-radius: 12px; font-size: 13px; color: var(--fg2);
  }
  .why li + li { margin-top: 5px; }
  .card {
    background: var(--card); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 22px 22px 18px;
  }
  .card-top { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
  .card-top .grade { margin-left: auto; }
  .why summary:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }

  /*
   * 다크 모드. 토큰만 갈아끼우므로 두 화면(내부 리포트 · 공개 랜딩)이 함께 따라온다.
   *
   * 두 화면 모두 색을 직접 지정한 선언이 거의 없어서 이 방식이 성립한다. 공개
   * 페이지에 남아 있던 두 건(#e9ecef 구획선, .cta 흰 글자)도 토큰으로 바꿨다.
   * 앞으로 색을 하드코딩하면 다크에서 조용히 깨지므로 항상 토큰을 쓴다.
   *
   * 그림자를 어둡게 유지하면 어두운 배경에서 보이지 않으므로, 카드 구획을 그림자
   * 대신 미세한 테두리로 잡는다.
   */
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16181d;
      --card: #1e2127;
      --fg: #e8eaed;
      --fg2: #b0b6bf;
      --muted: #858c96;
      --primary: #62a2ff;
      --primary-dark: #8bbaff;
      --primary-weak: #1b2b42;
      --primary-weak2: #24395a;
      --hot: #ff6b78;
      --hot-weak: #3a1f24;
      --warn-weak: #3a2f1c;
      --warn-fg: #f0b45c;
      --line: #2b2f37;
      --line-strong: #2b2f37;
      --hover: #2b2f37;
      --chip-bg: #24272e;
      --chip-line: #333842;
      --dup-bg: #3a1f24;
      --dup-fg: #ff8f99;
      /* 솔리드 배경이 전부 밝아지므로 그 위 글자는 어두워야 한다. */
      --on-fg: #16181d;
      --on-primary: #0f1a2b;
      --on-hot: #2a1013;
      --shadow: 0 0 0 1px rgba(255, 255, 255, .05);
    }
  }
`;

/* ================================================================== *
 * 카드 렌더링
 * ================================================================== */

/**
 * 카드 문구 로케일.
 *
 * 내부 리포트는 한국어(운영자용), 공개 랜딩은 영어(대상이 미국 기업과 영어권
 * 프리랜서)다. 한 화면에 두 언어가 섞이는 것을 막기 위해 라벨을 주입한다.
 */
interface CardLabels {
  daysUnfilled: (n: number) => string;
  ageUnknown: string;
  proofTitle: string;
  confidence: (pct: number) => string;
  signals: (n: number) => string;
  whySummary: string;
}

const KO_LABELS: CardLabels = {
  daysUnfilled: (n) => `${n}일째 미채용`,
  ageUnknown: '경과 미확인',
  proofTitle: 'Wayback Machine 아카이브가 그 시점에 공고가 존재했음을 증명한 값입니다',
  confidence: (pct) => `신뢰도 ${pct}%`,
  signals: (n) => `신호 ${n}개`,
  whySummary: '판단 근거 보기',
};

const EN_LABELS: CardLabels = {
  daysUnfilled: (n) => `${n} days unfilled`,
  ageUnknown: 'Age unverified',
  proofTitle:
    'Verified by the Wayback Machine: this exact posting existed on that date',
  confidence: (pct) => `${pct}% confidence`,
  signals: (n) => `${n} signal${n === 1 ? '' : 's'}`,
  whySummary: 'See the evidence',
};

/**
 * 경과일 배지. 이 화면에서 가장 먼저 읽혀야 하는 정보다.
 *
 * 값 구간에 따라 대비를 다르게 준다. 모든 배지를 같은 강도로 칠하면 "750일"과
 * "95일"이 같은 무게로 보이는데 실제 리드 가치는 크게 다르다.
 */
function ageBadge(lead: Lead, t: CardLabels): string {
  if (lead.ageDays === null) {
    return `<span class="sig sig-none">${esc(t.ageUnknown)}</span>`;
  }
  const days = lead.ageDays;
  const proof = lead.ageFromArchive
    ? ` <abbr title="${esc(t.proofTitle)}">&#10003;</abbr>`
    : '';
  const tone = days >= 365 ? 'hot' : days >= 180 ? 'warn' : 'calm';
  const fire = days >= 365 ? ' 🔥' : '';
  return `<span class="sig sig-${tone}">${esc(t.daysUnfilled(days))}${fire}${proof}</span>`;
}

/**
 * 영문 근거 문구를 구조화된 필드에서 직접 생성한다.
 *
 * `lead.reasons` 를 쓰지 않는 이유: 그 문구는 스코어링(score.ts)이 한국어로
 * 생성한 것이라 영어 페이지에 그대로 넣으면 언어가 섞인다. 번역 테이블로 문자열을
 * 되짚는 방식은 스코어링 문구가 바뀔 때마다 조용히 깨진다. 그래서 원본 수치에서
 * 다시 만든다 — 표현은 달라도 근거는 같은 데이터다.
 */
function evidenceEn(lead: Lead): string[] {
  const out: string[] = [];

  if (lead.ageDays !== null) {
    out.push(
      lead.ageFromArchive
        ? `Open for ${lead.ageDays}+ days, confirmed by an independent web archive — not the ATS's self-reported date`
        : `Open for ${lead.ageDays}+ days according to the ATS`,
    );
  }
  if (lead.tags.length > 0) {
    // 화면의 태그 칩과 같은 개수만 나열한다. 근거에만 등장하고 칩에는 없는 태그가
    // 보이면 데이터가 어긋난 것처럼 읽힌다.
    out.push(`Unstaffed stack: ${lead.tags.slice(0, 5).join(', ')}`);
  }
  out.push(
    `${lead.signals} independent signal${lead.signals === 1 ? '' : 's'} agreed, ` +
      `at ${Math.round(lead.confidence * 100)}% confidence`,
  );
  if (lead.locationRaw) {
    const wp =
      lead.workplaceType && lead.workplaceType !== 'unknown'
        ? `, ${lead.workplaceType}`
        : '';
    out.push(`Based in ${lead.locationRaw}${wp}`);
  }
  return out;
}

function cardBody(
  lead: Lead,
  t: CardLabels = KO_LABELS,
  evidence?: string[],
): string {
  const tags = lead.tags
    .slice(0, 5)
    .map((tag) => `<span class="tag">${esc(tag)}</span>`)
    .join('');

  const meta = [
    lead.locationRaw ? esc(lead.locationRaw) : null,
    lead.workplaceType && lead.workplaceType !== 'unknown'
      ? esc(lead.workplaceType)
      : null,
    esc(t.confidence(Math.round(lead.confidence * 100))),
    esc(t.signals(lead.signals)),
  ]
    .filter(Boolean)
    .join(' · ');

  const lines = (evidence ?? lead.reasons).map((r) => `<li>${esc(r)}</li>`).join('');

  return `
  <div class="card-top">
    ${ageBadge(lead, t)}
    <span class="grade grade-${esc(lead.grade)}">${esc(lead.grade)}</span>
  </div>

  <div class="company">${esc(lead.company)}</div>
  <h2 class="title">
    <a href="${safeUrl(lead.jobUrl)}" target="_blank" rel="noopener noreferrer">${esc(lead.title)}</a>
  </h2>

  ${tags ? `<div class="tags">${tags}</div>` : ''}
  <div class="meta">${meta}</div>

  <details class="why">
    <summary>${esc(t.whySummary)}</summary>
    <ul>${lines}</ul>
  </details>`;
}

/**
 * 회사 단위 카드.
 *
 * 공고 카드보다 정보 밀도를 높인다. 이 화면의 목적은 "어느 회사에 접근할까"를
 * 고르는 것이므로, 한 화면에 여러 회사가 들어와야 비교가 된다. 개별 자리는
 * 펼쳐서 본다(자리가 하나면 접어둔다 — 펼칠 게 없다).
 */
function renderCompanyCard(g: CompanyGroup, index: number): string {
  const ageTone =
    g.maxAge === null
      ? 'none'
      : g.maxAge >= 365
        ? 'hot'
        : g.maxAge >= 180
          ? 'warn'
          : 'calm';
  const ageText =
    g.maxAge === null ? '경과 미확인' : `최장 ${g.maxAge}일 미채용${g.maxAge >= 365 ? ' 🔥' : ''}`;

  const tags = g.tags
    .slice(0, 6)
    .map((t) => `<span class="tag">${esc(t)}</span>`)
    .join('');

  const ageCell = (days: number | null, archived: boolean) =>
    days === null
      ? '<span class="muted">—</span>'
      : `${days}일${archived ? '&#10003;' : ''}`;

  // 처음 몇 줄만 펼쳐 두고 나머지는 버튼으로 연다.
  //
  // 왜 전부 펼치지 않는가: cresta 는 직무가 13개다. 전부 펼치면 카드 하나가 화면을
  // 넘겨 회사 비교가 불가능해진다. 이 화면의 목적은 "어느 회사에 접근할까"이고
  // 비교에는 여러 카드가 한 화면에 들어와야 한다.
  //
  // 왜 전부 접지 않는가: 자리 목록이 이 카드의 내용 그 자체다. 종전에는
  // <details> 로 감싸 클릭해야 보였고, 자리가 하나인 회사는 그 하나마저 접혀
  // 있었다 - 펼칠 게 없는데 펼치게 만든 셈이다.
  //
  // 가장 오래 막힌 자리가 제안의 출발점이므로 정렬 상위 3개를 보여준다.
  const VISIBLE_ROLES = 3;
  const hiddenRoles = Math.max(0, g.roles.length - VISIBLE_ROLES);

  const roles = g.roles
    .map((r, ri) => {
      const age = ageCell(r.maxAge, r.ageFromArchive);
      // 넘치는 줄도 DOM 에는 남긴다. 검색·감사가 같은 노드를 세기 때문이다.
      const extra = ri >= VISIBLE_ROLES ? ' class="role-extra" hidden' : '';

      // 자리가 하나면 종전과 같이 제목에 링크를 건다. 이때는 base 가 아니라
      // 원문 제목을 쓴다 — 접을 게 없으므로 지역을 뗄 이유도 없다.
      const only = r.seats.length === 1 ? r.seats[0] : undefined;
      if (only) {
        return (
          `<li${extra}><span class="role-age">${age}</span>` +
          `<span class="role-body">` +
          `<a href="${safeUrl(only.jobUrl)}" target="_blank" rel="noopener noreferrer">${esc(only.title)}</a>` +
          `</span></li>`
        );
      }

      // 여러 건이면 제목을 한 번만 쓰고 자리를 칩으로 편다. 같은 제목에 링크를
      // 여러 번 걸면 어느 링크가 어느 자리인지 구분할 수 없다.
      const chips = r.seats
        .map((s) => {
          const days = s.ageDays === null ? '—' : `${s.ageDays}일`;
          const label = s.region ? `${esc(s.region)} · ${days}` : days;
          return (
            `<a class="seat" href="${safeUrl(s.jobUrl)}" target="_blank" rel="noopener noreferrer">` +
            `${label}${s.ageFromArchive ? '&#10003;' : ''}</a>`
          );
        })
        .join('');

      return (
        `<li${extra}><span class="role-age">${age}</span>` +
        `<span class="role-body">` +
        `<span class="role-name">${esc(r.title)}` +
        `<span class="role-dup" title="같은 직무로 ${r.seats.length}건이 동시에 열려 있습니다">&times;${r.seats.length}</span>` +
        `</span>` +
        `<span class="role-seats">${chips}</span>` +
        `</span></li>`
      );
    })
    .join('');

  // 접힌 게 있을 때만 직무 수를 덧붙인다. 같은 값을 두 번 쓰면 노이즈다.
  const collapsed = g.roleCount < g.count;
  const seatText = collapsed ? `${g.count}개 자리 · ${g.roleCount}개 직무` : `${g.count}개 자리`;

  // 초안용 직무 라벨. 지역 변형이면 지역을, 아니면 자리 수를 괄호로 밝힌다.
  // 초안 문구가 영어이므로 여기서도 영어를 쓴다.
  const draftRoles = g.roles.map((r) => {
    const only = r.seats.length === 1 ? r.seats[0] : undefined;
    if (only) return only.title;
    const regions = r.seats.map((s) => s.region).filter((x): x is string => Boolean(x));
    return regions.length === r.seats.length
      ? `${r.title} (${regions.join(', ')})`
      : `${r.title} (${r.seats.length} openings)`;
  });

  return `
<article class="group-card" data-groups="${esc([...g.tabGroups].join(' '))}"
         data-search="${esc(g.searchBlob)}" data-count="${g.count}"
         data-seats="${g.count}" data-rolecount="${g.roleCount}"
         data-hot="${g.hotCount}"
         data-age="${esc(g.maxAge ?? 0)}" data-rel="${g.topRel}"
         data-company="${esc(g.company)}"
         data-key="${esc(g.board || g.company)}"
         data-roles="${esc(JSON.stringify(draftRoles))}"
         data-tags="${esc(g.tags.slice(0, 4).join(', '))}">
  <div class="card-top">
    <span class="sig sig-${ageTone}">${esc(ageText)}</span>
    ${
      // hot 은 가장 행동을 부르는 값이므로 자리 수와 같은 회색 칩에 섞지 않는다.
      g.hotCount > 0
        ? `<span class="group-hot">hot ${g.hotCount}</span>`
        : ''
    }
    <span class="group-n">${esc(seatText)}</span>
  </div>

  <h2 class="title title-company">${esc(g.company)}</h2>
  <div class="meta">${esc(g.board)}${collapsed ? ` · 공고 ${g.count}건을 직무 ${g.roleCount}개로 묶음` : ''}</div>

  ${tags ? `<div class="tags">${tags}</div>` : ''}

  <ul class="role-list" id="roles-${index}">${roles}</ul>
  ${
    hiddenRoles > 0
      ? `<button type="button" class="role-toggle" data-more="${index}"
             aria-expanded="false" aria-controls="roles-${index}"
             data-label-more="직무 ${hiddenRoles}개 더 보기"
             data-label-less="접기">직무 ${hiddenRoles}개 더 보기</button>`
      : ''
  }

  <div class="card-cta">
    <button type="button" class="btn-mark" data-mark aria-pressed="false">
      <span aria-hidden="true">&#9633;</span> 연락함
    </button>
    <button type="button" class="btn-primary" data-gdraft="${index}">
      콜드메일 초안 <span aria-hidden="true">&rarr;</span>
    </button>
  </div>

  <div class="draft" id="gdraft-${index}" hidden>
    <div class="draft-head">
      <span>템플릿 기반 초안 · 보내기 전 반드시 다듬으세요</span>
      <button type="button" class="btn-ghost" data-gcopy="${index}">복사</button>
    </div>
    <textarea id="gdraft-text-${index}" rows="16" spellcheck="false" aria-label="회사 단위 콜드메일 초안"></textarea>
  </div>
</article>`;
}

/** 내부 리포트용 카드. 콜드메일 초안 CTA 를 포함한다. */
function renderCard(lead: Lead, index: number): string {
  const group = tabGroupOf(lead);

  // 초안 생성에 필요한 값만 data 속성으로 넘긴다. 본문은 저장하지 않으므로
  // 초안도 관측 신호만으로 구성된다.
  return `
<article class="card" data-group="${esc(group)}" data-grade="${esc(lead.grade)}"
         data-search="${esc(`${lead.company} ${lead.board} ${lead.title} ${lead.tags.join(' ')}`.toLowerCase())}"
         data-company="${esc(lead.company)}" data-title="${esc(lead.title)}"
         data-key="${esc(lead.board || lead.company)}"
         data-age="${esc(lead.ageDays ?? 0)}" data-rel="${lead.rel}"
         data-tags="${esc(lead.tags.slice(0, 4).join(', '))}"
         data-url="${safeUrl(lead.jobUrl)}">
  ${cardBody(lead)}

  <div class="card-cta">
    <button type="button" class="btn-primary" data-draft="${index}">
      콜드메일 초안 생성 <span aria-hidden="true">&rarr;</span>
    </button>
  </div>

  <div class="draft" id="draft-${index}" hidden>
    <div class="draft-head">
      <span>템플릿 기반 초안 · 보내기 전 반드시 다듬으세요</span>
      <button type="button" class="btn-ghost" data-copy="${index}">복사</button>
    </div>
    <textarea id="draft-text-${index}" rows="14" spellcheck="false" aria-label="콜드메일 초안"></textarea>
  </div>
</article>`;
}

/* ================================================================== *
 * 내부 리포트 (data/report.html)
 * ================================================================== */

/**
 * 키보드 단축키 목록.
 *
 * 화면에 표시하는 목록과 실제 배선을 한곳에서 만든다. 두 곳에 적으면 배선을 바꿀
 * 때 도움말이 조용히 거짓말을 하게 된다.
 */
const SHORTCUTS: ReadonlyArray<readonly [string, string]> = [
  ['j', '다음 카드'],
  ['k', '이전 카드'],
  ['d', '선택 카드의 초안 열기'],
  ['m', '선택 카드를 연락함으로 표시'],
  ['/', '검색으로 이동'],
  ['Esc', '초안 닫기 · 검색어 지우기 · 도움말 닫기'],
  ['1‒9', '직군 탭 선택'],
  ['0', '전체 탭'],
  ['v', '회사별 / 공고별 전환'],
  ['h', 'Hot만 보기'],
  ['u', '미연락만 보기'],
  ['s', '정렬 순환'],
  ['?', '이 도움말'],
];

function renderHtml(data: LeadsFile): string {
  const s = data.summary;
  const generated = new Date(data.generatedAt);

  const SHORTCUT_ROWS = SHORTCUTS.map(
    ([key, desc]) =>
      `<div class="help-row"><kbd>${esc(key)}</kbd><span>${esc(desc)}</span></div>`,
  ).join('');

  // 탭별 개수를 미리 계산한다. 개수가 0 인 탭은 렌더링하지 않는다 —
  // 눌러도 빈 화면이 나오는 탭은 사용자를 헛걸음시킨다.
  const counts = new Map<TabGroup, number>();
  for (const lead of data.leads) {
    const g = tabGroupOf(lead);
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }

  const tabs = TAB_LABELS.filter(
    (t) => t.key === 'all' || (counts.get(t.key as TabGroup) ?? 0) > 0,
  )
    .map((t, i) => {
      const n =
        t.key === 'all' ? data.leads.length : (counts.get(t.key as TabGroup) ?? 0);
      // role="tab" 을 쓰지 않는다. 탭 패턴은 tabpanel 과 방향키 이동을 요구하는데
      // 이건 목록을 걸러내는 필터다. 없는 위젯을 있다고 알리면 ARIA 를 안 쓰는
      // 것보다 나쁘다. 실제 동작에 맞게 aria-pressed 를 쓴다.
      return (
        `<button type="button" class="tab" data-tab="${esc(t.key)}"` +
        ` aria-pressed="${i === 0 ? 'true' : 'false'}">` +
        `${esc(t.label)}<span class="tab-n">${n}</span></button>`
      );
    })
    .join('');

  const cards = data.leads.map((lead, i) => renderCard(lead, i)).join('');

  const groups = groupByCompany(data.leads);
  const groupCards = groups.map((g, i) => renderCompanyCard(g, i)).join('');
  const multiRoleCompanies = groups.filter((g) => g.count > 1).length;

  // 나이 분포. 어디에 집중할지 판단하는 데 쓴다. 평균은 이 분포에서 의미가 없다 —
  // 꼬리가 길기 때문이다(최대 2000일대).
  const buckets = [
    { label: '365일+', min: 365, n: 0 },
    { label: '180-364일', min: 180, n: 0 },
    { label: '90-179일', min: 90, n: 0 },
    { label: '90일 미만', min: 0, n: 0 },
  ];
  for (const lead of data.leads) {
    const a = lead.ageDays ?? 0;
    const b = buckets.find((x) => a >= x.min);
    if (b) b.n++;
  }
  const bucketBars = buckets
    .map((b) => {
      const pct = data.leads.length ? Math.round((b.n / data.leads.length) * 100) : 0;
      return (
        `<div class="bar-row"><span class="bar-l">${esc(b.label)}</span>` +
        `<span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>` +
        `<span class="bar-n">${b.n}</span></div>`
      );
    })
    .join('');

  // 제외 감사. 이 필터는 정밀도를 위해 재현율을 희생하므로, 무엇을 버렸는지
  // 확인할 수 있어야 한다. 수임 가능한 직무를 잘못 걷어내면 리드가 조용히 사라진다.
  const droppedSamples = data.summary.droppedSamples ?? {};
  const droppedRows = Object.entries(data.summary.droppedByCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, n]) => {
      const samples = (droppedSamples[cat] ?? [])
        .slice(0, 6)
        .map((t) => `<li>${esc(t)}</li>`)
        .join('');
      return (
        `<div class="drop-row"><div class="drop-head">` +
        `<strong>${esc(cat)}</strong><span>${n}건</span></div>` +
        (samples ? `<ul class="drop-samples">${samples}</ul>` : '') +
        `</div>`
      );
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HireSignal 리드 — ${esc(generated.toISOString().slice(0, 10))}</title>
<style>
${DESIGN_TOKENS}
  /*
   * 폭을 넓힌 이유: 이 화면의 목적은 회사 비교이고, 비교에는 여러 카드가 한 화면에
   * 들어와야 한다. 720px 한 열에 98개 회사를 세로로 쌓으면 두 개씩 보이므로
   * 비교가 아니라 스크롤 노동이 된다.
   */
  .wrap { max-width: 1160px; margin: 0 auto; padding: 0 16px 96px; }
  /* 산문은 넓은 열에서 읽기 어려우므로 별도로 좁힌다. */
  .prose { max-width: 74ch; }

  header { padding: 32px 0 20px; }
  h1 { font-size: 26px; font-weight: 800; letter-spacing: -.02em; margin: 0 0 6px; }
  .stamp { color: var(--muted); font-size: 13px; margin: 0; }

  /* 요약: 숫자를 크게, 라벨은 작고 옅게. 시선이 숫자로 먼저 가야 한다. */
  .sr-only {
    position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
    overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
  }

  .summary {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
    background: var(--card); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 20px; margin-bottom: 10px;
  }
  .summary div { text-align: center; }
  .summary .n { font-size: 24px; font-weight: 800; letter-spacing: -.02em; }
  .summary .l { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .summary .hot { color: var(--hot); }

  /* 탭 + 검색은 스크롤 중에도 손에 닿아야 한다. */
  .sticky {
    position: sticky; top: 0; z-index: 10;
    background: var(--bg); padding: 8px 0 12px;
    /* 카드가 탭 아래로 지나갈 때 경계를 선이 아니라 페이드로 처리한다. */
    box-shadow: 0 12px 12px -12px rgba(0, 27, 55, .08);
  }
  .tabs {
    display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px;
    scrollbar-width: none; -ms-overflow-style: none;
  }
  .tabs::-webkit-scrollbar { display: none; }
  .tab {
    flex: 0 0 auto; border: 0; cursor: pointer; font: inherit; font-size: 14px;
    font-weight: 600; color: var(--fg2); background: var(--card);
    border-radius: 999px; padding: 9px 15px; white-space: nowrap;
    transition: background .12s, color .12s;
  }
  .tab:hover { background: var(--hover); }
  .tab:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  .tab[aria-pressed="true"] { background: var(--fg); color: var(--on-fg); }
  .tab-n { font-size: 12px; opacity: .55; margin-left: 5px; font-weight: 500; }
  /* 경과일 분포 */
  .dist {
    background: var(--card); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 16px 20px; margin-bottom: 16px;
  }
  .dist > summary {
    cursor: pointer; font-size: 13px; font-weight: 700; color: var(--fg2);
    list-style: none;
  }
  .dist > summary::-webkit-details-marker { display: none; }
  .dist > summary::after { content: " \\203A"; color: var(--primary); }
  .dist[open] > summary::after { content: " \\2304"; color: var(--primary); }
  .bars { margin-top: 14px; display: flex; flex-direction: column; gap: 7px; }
  .bar-row { display: flex; align-items: center; gap: 10px; font-size: 12.5px; }
  .bar-l { width: 78px; color: var(--fg2); flex: 0 0 auto; }
  .bar-track { flex: 1; height: 8px; background: var(--bg); border-radius: 999px; overflow: hidden; }
  .bar-fill { display: block; height: 100%; background: var(--primary); border-radius: 999px; }
  .bar-n { width: 42px; text-align: right; color: var(--muted); flex: 0 0 auto; }
  .dist-note { font-size: 12px; color: var(--muted); margin: 12px 0 0; }

  /* 검색 + 보기 전환 + 정렬.
     flex-wrap 이 없으면 좁은 화면에서 검색창이 0 폭까지 짜부라진다 — 세그먼트
     버튼 2개와 셀렉트는 폭이 고정이라 남는 공간을 검색창이 전부 뒤집어쓴다. */
  .controls { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; align-items: stretch; }
  .search { flex: 1 1 240px; min-width: 0; }
  .search input {
    width: 100%; border: 0; background: var(--card); font: inherit; font-size: 15px;
    color: var(--fg); border-radius: 14px; padding: 13px 15px; box-shadow: var(--shadow);
  }
  .seg {
    display: flex; background: var(--card); border-radius: 14px; padding: 4px;
    box-shadow: var(--shadow); flex: 0 0 auto;
  }
  .seg-btn {
    border: 0; cursor: pointer; font: inherit; font-size: 13.5px; font-weight: 700;
    color: var(--fg2); background: transparent; border-radius: 10px; padding: 8px 13px;
    white-space: nowrap;
  }
  .seg-btn[aria-pressed="true"] { background: var(--primary-weak); color: var(--primary); }
  .seg-btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; }
  .sort { display: flex; flex: 0 0 auto; }
  .sort select {
    border: 0; background: var(--card); font: inherit; font-size: 13.5px; font-weight: 600;
    color: var(--fg2); border-radius: 14px; padding: 0 12px; box-shadow: var(--shadow);
    cursor: pointer;
  }
  .sort select:focus-visible { outline: 2px solid var(--primary); }
  .search input::placeholder { color: var(--muted); }
  .search input:focus { outline: 2px solid var(--primary); outline-offset: 0; }

  /* 필터 결과 개수. 시각적으로는 작고 옅지만 aria-live 로 스크린리더에도 전달된다.
     필터를 눌렀는데 아무 피드백이 없으면 동작했는지 알 수 없다. */
  .result-count { font-size: 12.5px; color: var(--muted); margin: 0; }
  .count-row {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    margin: 14px 0 0; flex-wrap: wrap;
  }

  /* 단축키 도움말. 단축키는 발견되지 않으면 없는 기능이므로 입구를 화면에 둔다. */
  .help-btn {
    border: 0; cursor: pointer; font: inherit; font-size: 12.5px; font-weight: 700;
    color: var(--fg2); background: transparent; padding: 4px 2px;
  }
  .help-btn:hover { color: var(--primary); }
  .help-btn:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  kbd {
    font: inherit; font-size: 11.5px; font-weight: 700; color: var(--fg2);
    background: var(--chip-bg); border: 1px solid var(--chip-line);
    border-radius: 6px; padding: 1px 6px; margin-left: 2px;
  }
  .help {
    margin-top: 10px; background: var(--card); border-radius: var(--radius);
    box-shadow: var(--shadow); padding: 18px 20px;
  }
  .help-grid {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: 8px 20px;
  }
  .help-row {
    display: flex; align-items: baseline; gap: 10px; font-size: 13px; color: var(--fg2);
  }
  .help-row kbd { flex: 0 0 auto; margin-left: 0; min-width: 30px; text-align: center; }
  .help-note { font-size: 12.5px; color: var(--muted); margin: 14px 0 0; max-width: 74ch; }
  .count-actions { display: flex; align-items: center; gap: 14px; }

  /* 연락 이력 백업. 손으로 쌓은 기록이라 브라우저에 갇혀 있으면 안 된다. */
  .help-io { margin-top: 18px; border-top: 1px solid var(--line); padding-top: 16px; }
  .help-io > strong { font-size: 13px; }
  .help-io textarea {
    width: 100%; margin-top: 10px; border: 1px solid var(--chip-line); border-radius: 10px;
    padding: 10px 12px; resize: vertical; color: var(--fg); background: var(--chip-bg);
    font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .help-io textarea:focus { outline: 2px solid var(--primary); }
  .help-io-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .help-io-msg { font-size: 12.5px; color: var(--muted); }
  .help-io-msg[data-tone="bad"] { color: var(--hot); font-weight: 700; }
  .help-io-msg[data-tone="good"] { color: var(--primary); font-weight: 700; }

  /*
   * 반응형 그리드. auto-fill + minmax 로 폭에 따라 열 수가 정해진다.
   * 카드 최소 폭 340px 은 "Senior Software Engineer, Backend (AI Agent Integrations)"
   * 급 제목이 세 줄 안에 들어가는 하한이다.
   *
   * align-items:start 가 없으면 같은 행의 카드가 가장 큰 카드 높이로 늘어나
   * 자리 목록 아래에 빈 공간이 생긴다.
   */
  .feed {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 12px; margin-top: 10px; align-items: start;
  }
  /* 초안을 펼친 카드는 전체 폭을 쓴다. JS 가 붙이는 클래스로 제어한다 —
     :has() 로도 되지만 이 리포트는 file:// 로 열리는 경우가 많아 지원 폭이 넓은
     쪽을 택한다. */
  .feed .is-drafting { grid-column: 1 / -1; }

  /* CTA: 카드 우측 하단 */
  .card-cta {
    display: flex; justify-content: flex-end; align-items: center; gap: 8px;
    margin-top: 16px; flex-wrap: wrap;
  }

  /* 연락 표시.
     이 리포트의 최종 목적은 콜드메일인데 "이미 보낸 회사"를 알 방법이 없어
     같은 곳에 두 번 연락하게 된다. 서버가 없으므로 localStorage 에 담는다 —
     기기 간 동기화는 안 되지만 1인 운영에서는 이게 필요의 전부다. */
  .btn-mark {
    margin-right: auto; border: 1px solid var(--chip-line); cursor: pointer;
    font: inherit; font-size: 12.5px; font-weight: 700; color: var(--fg2);
    background: var(--chip-bg); border-radius: 10px; padding: 9px 13px;
    white-space: nowrap;
  }
  .btn-mark:hover { border-color: var(--primary); color: var(--primary); }
  .btn-mark:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  .btn-mark[aria-pressed="true"] {
    background: var(--primary-weak); border-color: transparent; color: var(--primary);
  }
  /* 연락한 회사는 옅게 내린다. 목록에서 지우지는 않는다 — 무엇을 이미 했는지도
     정보이고, 되돌리려면 카드가 보여야 한다. */
  .is-contacted { opacity: .55; }
  .is-contacted:hover, .is-contacted:focus-within { opacity: 1; }

  /* j/k 로 선택한 카드. 브라우저 기본 포커스 링은 프로그램적 포커스에서 잘 안
     나타나므로 명시적으로 표시한다. outline 을 쓰면 그리드 간격을 먹지 않는다. */
  .is-focused { outline: 2px solid var(--primary); outline-offset: 2px; }
  .is-focused.is-contacted { opacity: 1; }
  article:focus { outline: 2px solid var(--primary); outline-offset: 2px; }
  .btn-primary {
    border: 0; cursor: pointer; font: inherit; font-size: 14.5px; font-weight: 700;
    color: var(--on-primary); background: var(--primary); border-radius: 12px;
    padding: 12px 18px; transition: background .12s, transform .06s;
  }
  .btn-primary:hover { background: var(--primary-dark); }
  .btn-primary:active { transform: scale(.985); }
  .btn-primary:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }

  .draft { margin-top: 14px; background: var(--bg); border-radius: 14px; padding: 14px; }
  .draft-head {
    display: flex; align-items: center; justify-content: space-between;
    font-size: 12px; color: var(--muted); margin-bottom: 8px; gap: 8px;
  }
  .btn-ghost {
    border: 0; cursor: pointer; font: inherit; font-size: 12.5px; font-weight: 700;
    color: var(--primary); background: var(--primary-weak); border-radius: 8px;
    padding: 6px 12px; white-space: nowrap;
  }
  .btn-ghost:hover { background: var(--primary-weak2); }
  .draft textarea {
    width: 100%; border: 0; border-radius: 10px; padding: 14px; resize: vertical;
    font: 13px/1.7 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    color: var(--fg); background: var(--card);
  }
  .draft textarea:focus { outline: 2px solid var(--primary); }

  /* 회사 카드 */
  .group-card {
    background: var(--card); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 20px 22px 16px;
  }
  .group-n {
    margin-left: auto; font-size: 12.5px; font-weight: 700; color: var(--fg2);
    background: var(--bg); border-radius: 999px; padding: 5px 11px; white-space: nowrap;
  }
  .group-hot {
    font-size: 12px; font-weight: 800; color: var(--on-hot); background: var(--hot);
    border-radius: 999px; padding: 4px 10px; white-space: nowrap;
    letter-spacing: .01em;
  }
  .title-company { font-size: 20px; margin-bottom: 2px; }

  /* 자리 목록. 배경을 깔아 카드 안에서 하나의 블록으로 읽히게 한다. */
  .role-list {
    list-style: none; margin: 12px 0 0; padding: 8px 14px;
    background: var(--bg); border-radius: 14px;
  }

  .role-toggle {
    margin-top: 8px; border: 0; cursor: pointer; font: inherit; font-size: 12.5px;
    font-weight: 700; color: var(--primary); background: transparent; padding: 6px 2px;
  }
  .role-toggle:hover { text-decoration: underline; }
  .role-toggle:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  .role-list li {
    display: flex; gap: 10px; align-items: baseline; padding: 5px 0;
    font-size: 14px;
  }
  /* 숨은 줄을 건너뛰고 경계선을 그린다. :not([hidden]) 이 없으면 접힌 상태에서
     마지막 보이는 줄 아래에 선이 남는다. */
  .role-list li:not([hidden]) + li:not([hidden]) {
    border-top: 1px solid var(--line); padding-top: 8px; margin-top: 3px;
  }
  .role-age {
    flex: 0 0 74px; font-size: 12.5px; font-weight: 700; color: var(--fg2);
    font-variant-numeric: tabular-nums;
  }
  .role-list a { color: var(--fg); text-decoration: none; font-weight: 600; }
  .role-list a:hover { color: var(--primary); text-decoration: underline; }
  .role-list a:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }

  /* 같은 직무가 여러 건일 때: 제목 한 줄 + 자리 칩 한 줄.
     min-width:0 이 없으면 긴 제목이 flex 아이템을 밀어 카드를 넘친다. */
  .role-body { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
  .role-name { font-weight: 600; color: var(--fg); }
  .role-dup {
    display: inline-block; margin-left: 6px; padding: 0 6px;
    border-radius: 999px; background: var(--dup-bg); color: var(--dup-fg);
    font-size: 11.5px; font-weight: 700; vertical-align: 1px;
  }
  .role-seats { display: flex; flex-wrap: wrap; gap: 5px; }
  /* .role-list a 보다 명시도가 높아야 색이 먹는다 (클래스 2개 > 클래스1+타입1). */
  .role-seats .seat {
    padding: 1px 8px; border: 1px solid var(--chip-line); border-radius: 999px;
    background: var(--chip-bg); color: var(--fg2); text-decoration: none;
    font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums;
  }
  .role-seats .seat:hover {
    border-color: var(--primary); color: var(--primary); text-decoration: none;
  }
  .role-seats .seat:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  .muted { color: var(--muted); }

  /* 제외 감사 */
  .audit {
    margin-top: 20px; background: var(--card); border-radius: var(--radius);
    box-shadow: var(--shadow); padding: 18px 22px;
  }
  .audit > summary {
    cursor: pointer; font-size: 13.5px; font-weight: 700; color: var(--fg2);
    list-style: none;
  }
  .audit > summary::-webkit-details-marker { display: none; }
  .audit > summary::after { content: " \\203A"; color: var(--primary); }
  .audit[open] > summary::after { content: " \\2304"; color: var(--primary); }
  .audit-note { font-size: 12.5px; color: var(--muted); margin: 12px 0 16px; }
  .drops { display: flex; flex-direction: column; gap: 12px; }
  .drop-row { background: var(--bg); border-radius: 12px; padding: 12px 14px; }
  .drop-head {
    display: flex; justify-content: space-between; font-size: 13px; color: var(--fg2);
  }
  .drop-samples {
    margin: 8px 0 0; padding-left: 18px; font-size: 12.5px; color: var(--muted);
  }
  .drop-samples li { margin-top: 3px; }

  .empty {
    text-align: center; color: var(--muted); padding: 60px 20px; font-size: 14px;
    grid-column: 1 / -1;
  }
  .empty .btn-ghost { margin-top: 14px; }
  .note {
    margin-top: 20px; background: var(--card); border-radius: var(--radius);
    box-shadow: var(--shadow); padding: 20px 22px; font-size: 13px; color: var(--fg2);
  }
  .note strong { color: var(--fg); }

  @media (max-width: 560px) {
    .card, .group-card { padding: 18px 18px 16px; }
    .title { font-size: 19px; }
    .title-company { font-size: 19px; }
    .summary { grid-template-columns: repeat(2, 1fr); padding: 16px; }
    .card-cta .btn-primary { width: 100%; }
    /* 좁은 화면에서는 검색이 한 줄을 다 쓰고 전환·정렬이 다음 줄로 내려간다. */
    .search { flex: 1 1 100%; }
    .seg, .sort { flex: 1 1 auto; }
    .sort select { width: 100%; }
    .role-age { flex-basis: 62px; }
  }

  /* 다크 토큰은 DESIGN_TOKENS 에 있어 두 화면이 함께 따라온다.
     여기에는 이 화면에만 필요한 보정만 둔다 — 어두운 배경에서 입력·탭의 경계가
     사라지므로 테두리 역할의 그림자를 되돌려준다. */
  @media (prefers-color-scheme: dark) {
    .search input, .sort select, .tab { box-shadow: var(--shadow); }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>오늘의 리드</h1>
    <p class="stamp">
      ${esc(generated.toISOString().replace('T', ' ').slice(0, 16))} UTC 갱신 ·
      스캔 ${esc(data.runId.slice(0, 8))}
    </p>
  </header>

  <section class="summary" aria-label="요약">
    <div><div class="n">${groups.length}</div><div class="l">회사</div></div>
    <div><div class="n">${s.total}</div><div class="l">리드</div></div>
    <div><div class="n hot">${s.hot}</div><div class="l">Hot</div></div>
    <div><div class="n">${multiRoleCompanies}</div><div class="l">복수 자리 정체</div></div>
  </section>

  <details class="dist">
    <summary>경과일 분포</summary>
    <div class="bars">${bucketBars}</div>
    <p class="dist-note">
      평균은 쓰지 않습니다. 꼬리가 길어서(최대 2,000일대) 평균이 분포를 왜곡합니다.
    </p>
  </details>

  <div class="sticky">
    <div class="tabs" role="group" aria-label="직군·스택 필터">${tabs}</div>
    <div class="controls">
      <div class="search">
        <input type="search" id="q" placeholder="회사명, 직무, 스택 검색"
               aria-label="회사명 또는 공고 제목 검색">
      </div>
      <div class="seg" role="group" aria-label="보기 방식">
        <button type="button" class="seg-btn" data-view="company" aria-pressed="true">회사별</button>
        <button type="button" class="seg-btn" data-view="lead" aria-pressed="false">공고별</button>
      </div>
      <div class="seg" role="group" aria-label="추가 필터">
        <button type="button" class="seg-btn" id="only-hot" aria-pressed="false"
                title="Hot 등급만 (단축키 h)">Hot만</button>
        <button type="button" class="seg-btn" id="only-todo" aria-pressed="false"
                title="연락하지 않은 회사만 (단축키 u)">미연락만</button>
      </div>
      <label class="sort">
        <span class="sr-only">정렬</span>
        <select id="sort" aria-label="정렬 기준">
          <option value="default">신호 강한 순</option>
          <option value="age">오래 막힌 순</option>
          <option value="count">자리 많은 순</option>
          <option value="company">회사명 순</option>
        </select>
      </label>
    </div>
  </div>

  <div class="count-row">
    <p class="result-count" id="count" role="status" aria-live="polite"></p>
    <div class="count-actions">
      <button type="button" class="help-btn" id="reset-btn" hidden>필터 초기화</button>
      <button type="button" class="help-btn" id="help-btn" aria-expanded="false" aria-controls="help">
        단축키 <kbd>?</kbd>
      </button>
    </div>
  </div>

  <div class="help" id="help" hidden>
    <div class="help-grid">${SHORTCUT_ROWS}</div>
    <p class="help-note">
      필터 상태는 주소에 저장됩니다 &mdash; 새로고침해도 유지되고, 그 주소를 그대로
      북마크하거나 공유할 수 있습니다.
    </p>

    <div class="help-io">
      <strong>연락 이력 백업</strong>
      <p class="help-note">
        연락 표시는 이 브라우저에만 저장됩니다. 손으로 쌓은 기록이라 잃으면 되살릴 수
        없으니, 브라우저를 비우거나 기기를 옮기기 전에 아래 JSON 을 보관하세요.
      </p>
      <textarea id="io" rows="3" spellcheck="false"
                aria-label="연락 이력 JSON"
                placeholder='{"greenhouse:cresta":"2026-07-31"}'></textarea>
      <div class="help-io-row">
        <button type="button" class="btn-ghost" id="io-dump">현재 이력 담기</button>
        <button type="button" class="btn-ghost" id="io-apply">붙여넣은 이력 적용</button>
        <span class="help-io-msg" id="io-msg" role="status" aria-live="polite"></span>
      </div>
    </div>
  </div>

  <div class="feed" id="groups">${groupCards}</div>
  <div class="feed" id="feed" hidden>${cards}</div>
  <div class="empty" id="empty" hidden>
    조건에 맞는 리드가 없습니다.
    <br>
    <button type="button" class="btn-ghost" id="empty-reset">필터 초기화</button>
  </div>

  <details class="audit">
    <summary>직군 필터가 제외한 ${s.droppedByRole}건 감사</summary>
    <p class="audit-note prose">
      이 필터는 정밀도를 위해 재현율을 희생합니다. 수임 가능한 직무를 잘못 걷어내면
      리드가 조용히 사라지므로, 무엇을 버렸는지 확인할 수 있어야 합니다.
      <code>other</code> 에 개발 직무가 보이면 <code>src/lib/signals/role.ts</code> 의
      분류기를 고쳐야 한다는 신호입니다.
    </p>
    <div class="drops">${droppedRows}</div>
  </details>

  <div class="note prose">
    <strong>이 리포트를 읽는 법.</strong>
    기본은 <strong>회사별</strong> 보기입니다. 프리랜서는 공고가 아니라 회사에 제안하고,
    같은 회사의 여러 자리가 흩어져 있으면 같은 곳에 중복으로 연락하게 됩니다.
    경과일은 "얼마나 채워지지 않고 있는가"이며 &#10003; 는 제3자 아카이브가 그 시점의
    존재를 증명한 값입니다. 신뢰도 50% 미만에서는 Hot 을 부여하지 않습니다.
    <br><br>
    <strong>같은 직무의 중복 공고는 접혀 있습니다.</strong>
    <span class="role-dup">&times;3</span> 배지는 같은 직무로 세 자리가 동시에 열려 있다는
    뜻입니다. 지역만 다른 변형도 함께 묶으며, 옆의 칩이 개별 공고 링크입니다. 이 구분은
    제안 논지를 바꿉니다 &mdash; "여러 분야를 못 뽑는다"보다 "이 한 자리를 여러 번
    시도하고도 못 뽑았다"가 더 강한 근거입니다. 접미사가 알려진 지역 표현일 때만 묶으므로,
    묶이지 않은 변형이 보이면 그대로 개별 직무로 읽으면 됩니다.
    <br><br>
    <strong>카드는 오래 막힌 직무 3개만 펼쳐 둡니다.</strong>
    나머지는 <em>직무 N개 더 보기</em>로 엽니다. 전부 펼치면 직무가 13개인 회사 하나가
    화면을 넘겨 회사 비교가 불가능해집니다. 검색은 접힌 직무까지 포함해 걸립니다.
    <br><br>
    <strong>콜드메일 초안은 템플릿 기반입니다.</strong>
    관측된 신호(경과일·집중 채용·스택)만으로 구성하며 LLM 을 쓰지 않습니다. 그래서
    근거가 사실이고 API 키 없이 오프라인에서도 동작합니다. 그대로 보내지 말고 본인
    이력과 맥락을 넣어 다듬으세요.
    <br><br>
    공개 랜딩: <a href="https://xiangbaej.github.io/hiresignal/" target="_blank" rel="noopener noreferrer">xiangbaej.github.io/hiresignal</a>
  </div>
</div>

<script>
(function () {
  var leadFeed = document.getElementById('feed');
  var groupFeed = document.getElementById('groups');
  var leadCards = Array.prototype.slice.call(leadFeed.querySelectorAll('.card'));
  var groupCards = Array.prototype.slice.call(groupFeed.querySelectorAll('.group-card'));
  var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  /* 보기 전환 버튼만 담는다.
     ".seg-btn" 전체를 잡으면 안 된다 — Hot만·미연락만 버튼도 같은 클래스를 쓰는데,
     setView 가 segs 전부의 aria-pressed 를 data-view 기준으로 덮으므로 보기를
     전환할 때마다 그 두 필터가 조용히 꺼진다. 실제로 그 결함이 있었다. */
  var segs = Array.prototype.slice.call(document.querySelectorAll('.seg-btn[data-view]'));
  var q = document.getElementById('q');
  var sortSel = document.getElementById('sort');
  var empty = document.getElementById('empty');
  var count = document.getElementById('count');

  var onlyHot = document.getElementById('only-hot');
  var onlyTodo = document.getElementById('only-todo');
  var help = document.getElementById('help');
  var helpBtn = document.getElementById('help-btn');
  var resetBtn = document.getElementById('reset-btn');
  var io = document.getElementById('io');
  var ioMsg = document.getElementById('io-msg');

  var activeTab = 'all';
  var view = 'company';

  /* ── 연락 이력 ──
     서버가 없으므로 localStorage 에 담는다. file:// 에서는 오리진이 불투명해
     접근 자체가 막히는 브라우저가 있으므로 모든 접근을 try 로 감싼다 —
     저장이 안 되더라도 리포트의 나머지 기능은 살아 있어야 한다. */
  var STORE_KEY = 'hiresignal.contacted.v1';
  var contacted = {};
  try {
    contacted = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {};
  } catch (err) { contacted = {}; }

  function saveContacted() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(contacted)); } catch (err) {}
  }

  function paintContacted(card) {
    var key = card.getAttribute('data-key');
    var on = !!contacted[key];
    var btn = card.querySelector('[data-mark]');
    card.classList.toggle('is-contacted', on);
    if (btn) {
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.innerHTML = on
        ? '<span aria-hidden="true">&#9745;</span> 연락함'
        : '<span aria-hidden="true">&#9633;</span> 연락함';
    }
  }

  /* 공고 카드까지 함께 칠한다.
     연락 표시는 회사 단위로만 남기지만, 공고별 보기에서 그 사실이 안 보이면
     같은 회사에 또 연락하게 된다 - 표시를 만든 이유가 그것이다. 공고 카드에는
     버튼을 두지 않는다(회사 단위 결정을 공고에서 뒤집으면 어느 쪽이 참인지
     알 수 없다). 옅게 내리는 것까지만 한다. */
  function repaintContacted() {
    groupCards.forEach(paintContacted);
    leadCards.forEach(paintContacted);
  }
  repaintContacted();

  function matchesTab(el) {
    if (activeTab === 'all') return true;
    if (view === 'lead') return el.getAttribute('data-group') === activeTab;
    /* 회사는 여러 직군을 동시에 채용할 수 있으므로 공백 구분 목록에 포함되는지 본다. */
    return (el.getAttribute('data-groups') || '').split(' ').indexOf(activeTab) !== -1;
  }

  function matchesHot(el) {
    if (onlyHot.getAttribute('aria-pressed') !== 'true') return true;
    return view === 'lead'
      ? el.getAttribute('data-grade') === 'hot'
      : Number(el.getAttribute('data-hot') || 0) > 0;
  }

  function matchesTodo(el) {
    if (onlyTodo.getAttribute('aria-pressed') !== 'true') return true;
    /* 연락 표시는 회사 단위로만 남긴다. 공고별 보기에서는 소속 회사 기준으로 본다. */
    var key = el.getAttribute('data-key');
    return !contacted[key];
  }

  function apply() {
    var term = q.value.trim().toLowerCase();
    var list = view === 'lead' ? leadCards : groupCards;
    var shown = 0;
    list.forEach(function (el) {
      var visible = matchesTab(el) && matchesHot(el) && matchesTodo(el) &&
        (term === '' || (el.getAttribute('data-search') || '').indexOf(term) !== -1);
      el.hidden = !visible;
      if (visible) shown++;
    });
    empty.hidden = shown !== 0;

    var totalN = view === 'lead' ? leadCards.length : groupCards.length;
    var unit = view === 'lead' ? '개 공고' : '개 회사';
    var marked = 0;
    for (var k in contacted) if (contacted[k]) marked++;
    count.textContent = shown + unit + ' (전체 ' + totalN + ')' +
      (marked > 0 ? ' · 연락함 ' + marked + '곳' : '');

    /* 필터가 걸려 있을 때만 초기화 버튼을 보인다. 항상 띄우면 누를 이유가 없는
       버튼이 상시로 자리를 차지하고, 결과가 0 일 때 원인을 찾는 단서도 못 된다. */
    resetBtn.hidden = !isFiltered();

    dropFocusIfHidden();
    writeHash();
  }

  /* 기본 상태에서 벗어났는가. 정렬은 결과 집합을 바꾸지 않으므로 세지 않는다. */
  function isFiltered() {
    return activeTab !== 'all' ||
      q.value.trim() !== '' ||
      onlyHot.getAttribute('aria-pressed') === 'true' ||
      onlyTodo.getAttribute('aria-pressed') === 'true';
  }

  function resetFilters() {
    selectTab('all');
    q.value = '';
    setPressed(onlyHot, false);
    setPressed(onlyTodo, false);
    apply();
  }

  function num(el, attr) { return Number(el.getAttribute(attr) || 0); }

  function sortNow() {
    var mode = sortSel.value;
    var container = view === 'lead' ? leadFeed : groupFeed;
    var list = (view === 'lead' ? leadCards : groupCards).slice();

    list.sort(function (a, b) {
      if (mode === 'age') return num(b, 'data-age') - num(a, 'data-age');
      if (mode === 'company') {
        return (a.getAttribute('data-company') || '')
          .localeCompare(b.getAttribute('data-company') || '');
      }
      if (mode === 'count') {
        /* 공고별 보기에는 자리 수 개념이 없으므로 기본 정렬로 되돌린다. */
        var d = num(b, 'data-count') - num(a, 'data-count');
        if (d !== 0) return d;
        return num(b, 'data-age') - num(a, 'data-age');
      }
      return num(b, 'data-rel') - num(a, 'data-rel');
    });

    /* DocumentFragment 로 한 번에 옮긴다. 455개를 개별 appendChild 하면
       레이아웃이 여러 번 재계산된다. */
    var frag = document.createDocumentFragment();
    list.forEach(function (el) { frag.appendChild(el); });
    container.appendChild(frag);
  }

  function setView(next) {
    view = next;
    leadFeed.hidden = view !== 'lead';
    groupFeed.hidden = view !== 'company';
    segs.forEach(function (s) {
      s.setAttribute('aria-pressed', s.getAttribute('data-view') === view ? 'true' : 'false');
    });
    /* 자리 수 정렬은 회사별 보기에서만 의미가 있다. */
    var countOpt = sortSel.querySelector('option[value="count"]');
    if (countOpt) countOpt.disabled = view === 'lead';
    if (view === 'lead' && sortSel.value === 'count') sortSel.value = 'default';
    sortNow();
    apply();
  }

  /* ── 필터 상태를 URL 에 담는다 ──
     새로고침하면 탭·검색·정렬이 초기화되던 문제를 없애고, 특정 조합을 북마크하거나
     남에게 보낼 수 있게 한다. pushState 대신 replaceState 를 쓴다 — 필터 조작마다
     히스토리가 쌓이면 뒤로가기가 필터 되돌리기가 되어 페이지를 벗어날 수 없다. */
  var writingHash = false;

  function writeHash() {
    var p = [];
    if (view !== 'company') p.push('view=' + view);
    if (activeTab !== 'all') p.push('tab=' + activeTab);
    if (sortSel.value !== 'default') p.push('sort=' + sortSel.value);
    if (q.value.trim()) p.push('q=' + encodeURIComponent(q.value.trim()));
    if (onlyHot.getAttribute('aria-pressed') === 'true') p.push('hot=1');
    if (onlyTodo.getAttribute('aria-pressed') === 'true') p.push('todo=1');
    var next = p.length ? '#' + p.join('&') : '';
    if (next === (location.hash || '')) return;
    writingHash = true;
    try {
      history.replaceState(null, '', location.pathname + location.search + next);
    } catch (err) {
      /* file:// 에서 replaceState 가 막히는 브라우저가 있다. 상태 저장은 부가
         기능이므로 실패해도 화면은 그대로 동작해야 한다. */
    }
    writingHash = false;
  }

  function readHash() {
    var raw = (location.hash || '').replace(/^#/, '');
    if (!raw) return null;
    var out = {};
    raw.split('&').forEach(function (pair) {
      var eq = pair.indexOf('=');
      if (eq === -1) return;
      out[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
    });
    return out;
  }

  function setPressed(btn, on) {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function selectTab(key) {
    var found = false;
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-tab') === key;
      if (on) found = true;
      setPressed(t, on);
    });
    if (found) activeTab = key;
    return found;
  }

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      selectTab(tab.getAttribute('data-tab'));
      apply();
    });
  });
  segs.forEach(function (s) {
    s.addEventListener('click', function () { setView(s.getAttribute('data-view')); });
  });

  [onlyHot, onlyTodo].forEach(function (btn) {
    btn.addEventListener('click', function () {
      setPressed(btn, btn.getAttribute('aria-pressed') !== 'true');
      apply();
    });
  });

  /* 연락 표시 토글 */
  groupFeed.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-mark]');
    if (!btn) return;
    var card = btn.closest('article');
    var key = card.getAttribute('data-key');
    if (contacted[key]) delete contacted[key];
    else contacted[key] = new Date().toISOString().slice(0, 10);
    saveContacted();
    repaintContacted();
    apply();
  });
  /* 정렬은 화면만 바꾸므로 apply() 를 부르지 않는다. 대신 상태 저장은 해야 한다 —
     writeHash 를 빼먹으면 셀렉트로 바꾼 정렬만 새로고침에서 사라져, 단축키로
     바꿀 때는 유지되는 비일관이 생긴다. */
  sortSel.addEventListener('change', function () { sortNow(); writeHash(); });

  /* 검색은 디바운스한다.
     결과 개수가 aria-live 영역이라, 키를 누를 때마다 갱신하면 스크린리더가 글자
     수만큼 읽어대 오히려 방해가 된다. 필터링 자체도 카드 555개 속성 조회라
     매 입력마다 돌릴 이유가 없다. */
  var searchTimer = null;
  q.addEventListener('input', function () {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(apply, 180);
  });
  /* 엔터·지우기는 기다리지 않고 즉시 반영한다. */
  q.addEventListener('search', function () {
    if (searchTimer) clearTimeout(searchTimer);
    apply();
  });

  /* 직무 목록 더 보기. 넘치는 줄은 DOM 에 남아 있고 hidden 만 토글한다. */
  groupFeed.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-more]');
    if (!btn) return;
    var card = btn.closest('article');
    var extras = Array.prototype.slice.call(card.querySelectorAll('.role-extra'));
    var open = btn.getAttribute('aria-expanded') === 'true';
    extras.forEach(function (li) { li.hidden = open; });
    btn.setAttribute('aria-expanded', open ? 'false' : 'true');
    btn.textContent = open
      ? btn.getAttribute('data-label-more')
      : btn.getAttribute('data-label-less');
  });

  /* ── 키보드 단축키 ──
     매일 여는 도구라 손이 마우스를 떠나지 않는 편이 빠르다. 입력 중에는 동작하지
     않아야 하므로 포커스가 입력 요소에 있으면 전부 무시한다. */
  function toggleHelp(force) {
    if (!help) return;
    var next = typeof force === 'boolean' ? force : help.hidden;
    help.hidden = !next;
    if (helpBtn) helpBtn.setAttribute('aria-expanded', next ? 'true' : 'false');
  }
  if (helpBtn) helpBtn.addEventListener('click', function () { toggleHelp(); });
  resetBtn.addEventListener('click', resetFilters);
  document.getElementById('empty-reset').addEventListener('click', resetFilters);

  /* ── 연락 이력 백업 ──
     손으로 쌓은 기록이 브라우저 하나에 갇혀 있으면 캐시를 비우는 순간 사라진다.
     서버가 없으니 JSON 을 사람이 옮기는 것이 유일한 경로다. */
  function ioSay(text, tone) {
    ioMsg.textContent = text;
    if (tone) ioMsg.setAttribute('data-tone', tone);
    else ioMsg.removeAttribute('data-tone');
  }

  document.getElementById('io-dump').addEventListener('click', function () {
    io.value = JSON.stringify(contacted);
    io.focus();
    io.select();
    var n = Object.keys(contacted).length;
    ioSay(n + '곳을 담았습니다. 복사해 보관하세요.', 'good');
  });

  document.getElementById('io-apply').addEventListener('click', function () {
    var raw = io.value.trim();
    if (!raw) { ioSay('붙여넣을 JSON 이 비어 있습니다.', 'bad'); return; }

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      ioSay('JSON 형식이 아닙니다. 담아둔 내용을 그대로 붙여넣으세요.', 'bad');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      ioSay('회사키:날짜 형태의 객체여야 합니다.', 'bad');
      return;
    }

    /* 덮어쓰지 않고 합친다. 지금 기기에서 표시한 것을 가져오기가 날려 버리면
       복구할 수 없다 - 이력은 사후에 메울 수 없는 손 기록이다. */
    var added = 0;
    var known = {};
    groupCards.forEach(function (c) { known[c.getAttribute('data-key')] = 1; });
    var unknown = 0;
    for (var key in parsed) {
      if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
      if (!known[key]) { unknown++; continue; }
      if (!contacted[key]) { contacted[key] = parsed[key] || '1'; added++; }
    }

    saveContacted();
    repaintContacted();
    apply();
    ioSay(
      added + '곳을 추가했습니다.' +
        (unknown > 0 ? ' 현재 목록에 없는 ' + unknown + '곳은 건너뜁니다.' : ''),
      'good',
    );
  });

  /* ── 카드 이동 ──
     이 도구의 하루 루프는 "훑고 → 하나 고르고 → 초안 열고 → 복사하고 → 연락함
     표시"다. 고르는 단계만 마우스를 요구하면 나머지 단축키의 의미가 줄어든다.

     실제 DOM 포커스를 옮긴다. 클래스만 칠하면 스크린리더가 따라오지 않고,
     Enter 로 초안을 여는 것도 문서 전역 핸들러에 의존해야 한다. */
  var focused = null;

  /* DOM 을 다시 훑는다. leadCards/groupCards 배열을 쓰면 안 된다 — sortNow 가
     DocumentFragment 로 카드를 재배치하므로 배열 순서와 화면 순서가 갈라지고,
     그러면 j 가 "아래 카드"가 아니라 엉뚱한 위치로 튄다. 이동은 눈에 보이는
     순서를 따라야 한다. */
  function visibleCards() {
    var container = view === 'lead' ? leadFeed : groupFeed;
    var sel = view === 'lead' ? '.card' : '.group-card';
    return Array.prototype.slice.call(container.querySelectorAll(sel))
      .filter(function (el) { return !el.hidden; });
  }

  function focusCard(el) {
    if (focused && focused !== el) focused.classList.remove('is-focused');
    focused = el || null;
    if (!focused) return;
    focused.classList.add('is-focused');
    focused.setAttribute('tabindex', '-1');
    try { focused.focus(); } catch (err) {}
    /* jsdom 에는 scrollIntoView 가 없다. 없다고 던지면 이동 자체가 죽는다. */
    if (focused.scrollIntoView) {
      focused.scrollIntoView({ block: 'nearest' });
    }
  }

  function moveFocus(delta) {
    var list = visibleCards();
    if (list.length === 0) return;
    var at = focused ? list.indexOf(focused) : -1;
    var next = at === -1 ? (delta > 0 ? 0 : list.length - 1) : at + delta;
    if (next < 0) next = 0;
    if (next > list.length - 1) next = list.length - 1;
    focusCard(list[next]);
  }

  /* 필터가 바뀌어 선택한 카드가 사라지면 선택을 놓는다. 보이지 않는 카드에
     Enter 를 눌러 초안이 열리면 화면 어디에서도 그 초안을 볼 수 없다. */
  function dropFocusIfHidden() {
    if (focused && focused.hidden) {
      focused.classList.remove('is-focused');
      focused = null;
    }
  }

  function isTyping(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    /* Esc 는 입력 중에도 받는다. 유일한 탈출구이기 때문이다. */
    if (e.key === 'Escape') {
      /* 초안 안에 있으면 초안을 닫고 카드로 돌아온다.
         초안을 열면 편집을 위해 포커스가 textarea 로 가는데, 그 상태에서는 문자
         단축키가 전부 글자로 들어간다. Esc 가 없으면 키보드만으로는 초안을 닫지도
         다음 카드로 넘어가지도 못한다. */
      var active = document.activeElement;
      var inDraft = active && active.closest ? active.closest('.draft') : null;
      if (inDraft) {
        var host = inDraft.closest('article');
        var toggle = host && host.querySelector('[data-gdraft], [data-draft]');
        if (toggle) toggle.click();
        if (host) focusCard(host);
        return;
      }
      if (help && !help.hidden) { toggleHelp(false); return; }
      if (q.value) { q.value = ''; apply(); }
      if (active === q) q.blur();
      return;
    }

    if (isTyping(document.activeElement)) return;

    if (e.key === '/') { e.preventDefault(); q.focus(); q.select(); return; }
    if (e.key === '?') { e.preventDefault(); toggleHelp(); return; }

    if (e.key === 'j') { e.preventDefault(); moveFocus(1); return; }
    if (e.key === 'k') { e.preventDefault(); moveFocus(-1); return; }
    if (e.key === 'd' || e.key === 'Enter') {
      if (!focused) { moveFocus(1); return; }
      var draftBtn = focused.querySelector('[data-gdraft], [data-draft]');
      if (draftBtn) { e.preventDefault(); draftBtn.click(); }
      return;
    }
    if (e.key === 'm') {
      /* 연락 표시는 회사 단위 결정이므로 회사 카드에만 버튼이 있다. */
      if (!focused) return;
      var markBtn = focused.querySelector('[data-mark]');
      if (markBtn) markBtn.click();
      return;
    }

    if (e.key === 'v') { setView(view === 'company' ? 'lead' : 'company'); return; }
    if (e.key === 'h') { onlyHot.click(); return; }
    if (e.key === 'u') { onlyTodo.click(); return; }
    if (e.key === 's') {
      /* 정렬을 순환한다. 공고별 보기에서 비활성인 항목은 건너뛴다. */
      var opts = Array.prototype.slice.call(sortSel.options).filter(function (o) {
        return !o.disabled;
      });
      var at = opts.indexOf(sortSel.options[sortSel.selectedIndex]);
      sortSel.value = opts[(at + 1) % opts.length].value;
      sortNow();
      writeHash();
      return;
    }
    if (/^[0-9]$/.test(e.key)) {
      var idx = e.key === '0' ? 0 : Number(e.key);
      if (tabs[idx]) { tabs[idx].click(); }
      return;
    }
  });

  /* ── 초기 상태 복원 ──
     해시가 있으면 그대로 재현한다. setView 가 정렬과 필터를 함께 돌리므로
     값만 미리 채워 두고 마지막에 한 번 적용한다. */
  var initial = readHash();
  if (initial) {
    if (initial.tab) selectTab(initial.tab);
    if (initial.sort) sortSel.value = initial.sort;
    if (initial.q) q.value = initial.q;
    setPressed(onlyHot, initial.hot === '1');
    setPressed(onlyTodo, initial.todo === '1');
  }
  setView(initial && initial.view === 'lead' ? 'lead' : 'company');

  /* 뒤로/앞으로로 해시가 바뀌면 상태를 따라간다. 우리가 쓴 해시는 무시한다. */
  window.addEventListener('hashchange', function () {
    if (writingHash) return;
    var st = readHash() || {};
    selectTab(st.tab || 'all');
    sortSel.value = st.sort || 'default';
    q.value = st.q || '';
    setPressed(onlyHot, st.hot === '1');
    setPressed(onlyTodo, st.todo === '1');
    setView(st.view === 'lead' ? 'lead' : 'company');
  });

  /* ── 콜드메일 초안 ──
     LLM 을 쓰지 않는다. 관측된 신호만으로 구성하므로 근거가 사실이고, API 키 없이
     오프라인에서도 동작한다. 문구는 영어다 — 대상이 미국 기업이다. */
  function buildDraft(card) {
    var company = card.getAttribute('data-company') || 'there';
    var title = card.getAttribute('data-title') || 'the role';
    var age = card.getAttribute('data-age');
    var tags = card.getAttribute('data-tags') || '';
    var url = card.getAttribute('data-url') || '';

    var lines = [];
    lines.push('Subject: ' + title + ' \\u2014 outside help while the search continues?');
    lines.push('');
    lines.push('Hi ' + company + ' team,');
    lines.push('');

    var opener = 'I came across your ' + title + ' opening';
    if (age) {
      opener += ', which public web archives show has been posted for ' + age + '+ days';
    }
    lines.push(opener + '.');
    lines.push('');
    lines.push(
      'A long search usually means the work is piling up rather than pausing. ' +
      'I work as a freelancer' + (tags ? ' on ' + tags : '') + ', and I can take on ' +
      'scoped pieces of that workload while you keep looking for the right full-time hire.'
    );
    lines.push('');
    lines.push('A few ways that tends to help:');
    lines.push('  - clearing the backlog that is blocking the team right now');
    lines.push('  - owning one defined project end to end, on a fixed scope');
    lines.push('  - documenting it so your eventual hire ramps up faster');
    lines.push('');
    lines.push(
      'If that would be useful, I can send relevant work samples. ' +
      'Would a short call this week make sense?'
    );
    lines.push('');
    lines.push('Best,');
    lines.push('[your name] \\u00B7 [your site]');
    if (url) {
      lines.push('');
      lines.push('(Ref: ' + url + ')');
    }
    return lines.join('\\n');
  }

  /* 회사 단위 초안. 개별 공고가 아니라 "여러 자리가 동시에 막혀 있다"는 사실을
     근거로 쓴다. 같은 회사에 세 번 연락하는 실수를 막는 것이 이 뷰의 목적이다. */
  function buildGroupDraft(card) {
    var company = card.getAttribute('data-company') || 'there';

    /* 자리 목록은 JSON 으로 전달한다. 구분자 문자열을 쓰면 반드시 충돌한다 —
       실제 데이터에 "Customer Activation Manager | Mid-Market" 처럼 파이프가 든
       제목이 있고, 콤마는 더 흔하다. 제어문자(U+001F)도 HTML5 속성값에서
       비적합이라 파서가 제거할 수 있다. JSON 이면 충돌 자체가 불가능하다. */
    var roles = [];
    try {
      roles = JSON.parse(card.getAttribute('data-roles') || '[]') || [];
    } catch (err) {
      roles = [];
    }
    var age = card.getAttribute('data-age');
    var tags = card.getAttribute('data-tags') || '';
    var n = roles.length;
    var seats = Number(card.getAttribute('data-seats') || n);

    var lines = [];
    lines.push('Subject: ' + n + ' open ' + (n === 1 ? 'role' : 'roles') +
      ' at ' + company + ' \\u2014 interim help?');
    lines.push('');
    lines.push('Hi ' + company + ' team,');
    lines.push('');
    /* 자리 수가 직무 수보다 많으면 그 사실을 밝힌다. "같은 자리를 여러 번 올렸다"는
       것이 "여러 분야를 못 뽑는다"보다 강한 근거이므로 논지에서 빼면 손해다. */
    lines.push(
      'From the outside it looks like ' + n + ' ' + (n === 1 ? 'position' : 'positions') +
      ' on your team ' + (n === 1 ? 'has' : 'have') + ' been open for a while' +
      (seats > n ? ' (' + seats + ' separate postings)' : '') +
      (age && age !== '0' ? ', the longest for ' + age + '+ days' : '') + ':'
    );
    roles.slice(0, 6).forEach(function (r) { lines.push('  - ' + r); });
    if (roles.length > 6) lines.push('  - (+' + (roles.length - 6) + ' more)');
    lines.push('');
    lines.push(
      'When several roles in the same area stay open, the work usually does not stop ' +
      '\\u2014 it queues up behind the hire. I work as a freelancer' +
      (tags ? ' on ' + tags : '') + ' and can absorb part of that queue on a fixed ' +
      'scope while you keep searching.'
    );
    lines.push('');
    lines.push('Typically that looks like:');
    lines.push('  - taking one defined project off the critical path');
    lines.push('  - clearing the backlog that is blocking the rest of the team');
    lines.push('  - leaving documentation so your eventual hire ramps up faster');
    lines.push('');
    lines.push('Happy to send relevant samples. Would a short call make sense?');
    lines.push('');
    lines.push('Best,');
    lines.push('[your name] \\u00B7 [your site]');
    return lines.join('\\n');
  }

  function wireDraft(container, openAttr, copyAttr, idPrefix, builder) {
    container.addEventListener('click', function (e) {
      var openBtn = e.target.closest('[' + openAttr + ']');
      if (openBtn) {
        var i = openBtn.getAttribute(openAttr);
        var box = document.getElementById(idPrefix + '-' + i);
        var ta = document.getElementById(idPrefix + '-text-' + i);
        var article = openBtn.closest('article');
        if (box.hidden) {
          ta.value = builder(article);
          box.hidden = false;
          openBtn.setAttribute('data-label', openBtn.innerHTML);
          openBtn.textContent = '초안 닫기';
          ta.focus();
          ta.setSelectionRange(0, 0);
        } else {
          box.hidden = true;
          openBtn.innerHTML = openBtn.getAttribute('data-label') || '초안 생성';
        }
        /* 초안을 열면 카드가 그리드 전체 폭을 쓴다. 340px 열에 이메일 초안을
           넣으면 한 줄에 대여섯 단어만 들어가 다듬을 수 없다. */
        article.classList.toggle('is-drafting', !box.hidden);
        return;
      }

      var copyBtn = e.target.closest('[' + copyAttr + ']');
      if (!copyBtn) return;
      var j = copyBtn.getAttribute(copyAttr);
      var target = document.getElementById(idPrefix + '-text-' + j);
      target.select();
      var done = function () {
        copyBtn.textContent = '복사됨';
        setTimeout(function () { copyBtn.textContent = '복사'; }, 1600);
      };
      /* navigator.clipboard 는 https 또는 localhost 에서만 동작한다. 이 파일은
         file:// 로 열리는 경우가 많으므로 폴백이 필수다. */
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(target.value).then(done, function () {
          try { document.execCommand('copy'); done(); } catch (err) {}
        });
      } else {
        try { document.execCommand('copy'); done(); } catch (err) {}
      }
    });
  }

  wireDraft(groupFeed, 'data-gdraft', 'data-gcopy', 'gdraft', buildGroupDraft);

  leadFeed.addEventListener('click', function (e) {
    var draftBtn = e.target.closest('[data-draft]');
    if (draftBtn) {
      var i = draftBtn.getAttribute('data-draft');
      var box = document.getElementById('draft-' + i);
      var ta = document.getElementById('draft-text-' + i);
      var leadCard = draftBtn.closest('.card');
      if (box.hidden) {
        ta.value = buildDraft(leadCard);
        box.hidden = false;
        draftBtn.textContent = '초안 닫기';
        ta.focus();
        ta.setSelectionRange(0, 0);
      } else {
        box.hidden = true;
        draftBtn.innerHTML = '콜드메일 초안 생성 <span aria-hidden="true">&rarr;</span>';
      }
      leadCard.classList.toggle('is-drafting', !box.hidden);
      return;
    }

    var copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      var j = copyBtn.getAttribute('data-copy');
      var target = document.getElementById('draft-text-' + j);
      target.select();
      var done = function () {
        copyBtn.textContent = '복사됨';
        setTimeout(function () { copyBtn.textContent = '복사'; }, 1600);
      };
      /* navigator.clipboard 는 https 또는 localhost 에서만 동작한다. 이 파일은
         file:// 로 열리는 경우가 많으므로 폴백이 필수다. */
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(target.value).then(done, function () {
          try { document.execCommand('copy'); done(); } catch (err) {}
        });
      } else {
        try { document.execCommand('copy'); done(); } catch (err) {}
      }
    }
  });
})();
</script>
</body>
</html>
`;
}

/* ================================================================== *
 * 공개 티저 페이지 (docs/index.html)
 * ================================================================== */

/**
 * 공개용 페이지를 만든다.
 *
 * ── 왜 이걸 만드는가 ──
 *
 * 이 사업의 다음 관문은 "프리랜서가 이 리드에 돈을 낼 것인가"인데, 아웃바운드로
 * 물어볼 수 없는 상황이다. 그래서 반대 방향으로 검증한다 — 공개해 두고 관심을
 * 측정한다. 이메일 폼을 호스팅할 인프라가 없으므로 GitHub Issue 를 신청 창구로
 * 쓴다. 열린 이슈 수가 그대로 수요 지표가 된다.
 *
 * 전량을 공개하지 않는 이유는 두 가지다. 유료화 여지를 남겨야 하고, 무엇보다
 * "더 보려면 요청"이라는 행동이 있어야 관심을 측정할 수 있다. 무료로 전부 주면
 * 트래픽은 생기지만 지불 의향은 알 수 없다.
 *
 * 방법론을 상세히 공개한다. 이 제품의 차별점은 데이터가 아니라 "왜 이 판단을
 * 신뢰할 수 있는가"이고, 한계까지 밝히는 것이 오히려 신뢰를 만든다.
 */
function renderPublicHtml(data: LeadsFile): string {
  const s = data.summary;
  const generated = new Date(data.generatedAt);
  const preview = data.leads.slice(0, PUBLIC_PREVIEW_COUNT);
  const hidden = Math.max(0, s.total - preview.length);

  const boardCount = 188;

  // 가장 오래 막혀 있는 리드를 히어로 근거로 쓴다. 추상적인 주장보다 구체적인
  // 한 건이 설득력이 높고, 데이터가 실재한다는 증거도 된다.
  const headline = preview.find((l) => l.ageDays !== null) ?? preview[0];

  const cards = preview
    .map(
      (lead) =>
        `<article class="card">${cardBody(lead, EN_LABELS, evidenceEn(lead))}</article>`,
    )
    .join('');

  const heroProof = headline
    ? `${esc(headline.company)} has had <strong>${esc(headline.title)}</strong> open for ` +
      `<strong>${headline.ageDays ?? '—'} days</strong>.`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HireSignal — Unfilled job posts are outsourcing demand</title>
<meta name="description" content="HireSignal tracks public ATS and web-archive data to surface B2B accounts whose work is piling up behind a stalled hire.">
<meta property="og:title" content="HireSignal — Unfilled job posts are outsourcing demand">
<meta property="og:description" content="Verified 90+ day hiring backlogs, the stack that isn't getting done, and an outreach draft built from the evidence.">
<meta property="og:type" content="website">
<style>
${DESIGN_TOKENS}
  .wrap { max-width: 760px; margin: 0 auto; padding: 0 20px; }
  .section { padding: 64px 0; }
  .section + .section { border-top: 1px solid var(--line-strong); }
  h2 { font-size: 24px; font-weight: 800; letter-spacing: -.025em; margin: 0 0 8px; }
  .section-sub { font-size: 15px; color: var(--muted); margin: 0 0 28px; }
  p { color: var(--fg2); }

  /* ── Hero ── */
  .hero { padding: 88px 0 64px; text-align: center; }
  .eyebrow {
    display: inline-block; font-size: 12.5px; font-weight: 700; letter-spacing: .04em;
    text-transform: uppercase; color: var(--primary); background: var(--primary-weak);
    padding: 7px 14px; border-radius: 999px; margin-bottom: 22px;
  }
  .hero h1 {
    font-size: 42px; line-height: 1.22; font-weight: 800; letter-spacing: -.035em;
    margin: 0 auto 20px; max-width: 15em;
  }
  .hero .lede {
    font-size: 18px; line-height: 1.6; color: var(--fg2);
    margin: 0 auto 32px; max-width: 34em;
  }
  .cta {
    display: inline-block; background: var(--primary); color: var(--on-primary); text-decoration: none;
    font-weight: 700; font-size: 16px; padding: 16px 30px; border-radius: 14px;
    box-shadow: 0 6px 20px rgba(49, 130, 246, .28); transition: background .12s, transform .06s;
  }
  .cta:hover { background: var(--primary-dark); }
  .cta:active { transform: scale(.99); }
  .hero .proof {
    font-size: 14px; color: var(--muted); margin: 24px auto 0; max-width: 32em;
  }
  .hero .proof strong { color: var(--fg2); }

  /* 신뢰 지표를 히어로 바로 아래 둔다. 주장 다음에 숫자가 와야 설득이 된다. */
  .stats {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px;
    background: var(--card); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 22px; margin-top: 40px;
  }
  .stats div { text-align: center; }
  .stats .n { font-size: 25px; font-weight: 800; letter-spacing: -.025em; }
  .stats .l { font-size: 12px; color: var(--muted); margin-top: 3px; line-height: 1.35; }
  .stats .hot { color: var(--hot); }

  /* ── Value props ── */
  .values { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .value {
    background: var(--card); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 26px 22px;
  }
  .value .num {
    display: inline-flex; align-items: center; justify-content: center;
    width: 30px; height: 30px; border-radius: 10px; background: var(--primary-weak);
    color: var(--primary); font-weight: 800; font-size: 14px; margin-bottom: 14px;
  }
  .value h3 { font-size: 17px; font-weight: 800; letter-spacing: -.02em; margin: 0 0 8px; }
  .value p { font-size: 14px; margin: 0; line-height: 1.6; }

  /* ── Dashboard ── */
  .feed { display: flex; flex-direction: column; gap: 12px; }
  .footnote { font-size: 12.5px; color: var(--muted); margin-top: 14px; }
  .gate {
    background: var(--card); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 30px 24px; margin-top: 12px; text-align: center;
  }
  .gate .n {
    font-size: 30px; font-weight: 800; letter-spacing: -.03em; color: var(--primary);
  }
  .gate p { margin: 6px 0 0; font-size: 14.5px; }

  /* ── Form ── */
  .form-card {
    background: var(--card); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 30px 26px;
  }
  .field { margin-bottom: 14px; }
  .field label {
    display: block; font-size: 13px; font-weight: 700; color: var(--fg);
    margin-bottom: 6px;
  }
  .field input {
    width: 100%; border: 0; background: var(--bg); font: inherit; font-size: 15px;
    color: var(--fg); border-radius: 12px; padding: 14px 15px;
  }
  .field input::placeholder { color: var(--muted); }
  .field input:focus { outline: 2px solid var(--primary); }
  .btn-submit {
    width: 100%; border: 0; cursor: pointer; font: inherit; font-size: 16px;
    font-weight: 700; color: var(--on-primary); background: var(--primary); border-radius: 14px;
    padding: 16px; margin-top: 6px; transition: background .12s;
  }
  .btn-submit:hover { background: var(--primary-dark); }
  .fineprint { font-size: 12.5px; color: var(--muted); margin: 14px 0 0; line-height: 1.6; }

  /* ── Methodology / limits ── */
  .panel {
    background: var(--card); border-radius: var(--radius); box-shadow: var(--shadow);
    padding: 26px; font-size: 14.5px;
  }
  .panel ol { padding-left: 20px; margin: 0; }
  .panel li { margin-bottom: 14px; color: var(--fg2); line-height: 1.6; }
  .panel li:last-child { margin-bottom: 0; }
  .panel strong { color: var(--fg); }
  .limits { list-style: none; padding: 0; margin: 0; }
  .limits li {
    background: var(--card); border-radius: 14px; box-shadow: var(--shadow);
    padding: 17px 19px; margin-bottom: 10px; font-size: 14px; color: var(--fg2);
    line-height: 1.6;
  }
  .limits strong { color: var(--fg); }
  code {
    background: var(--bg); border-radius: 6px; padding: 2px 6px; font-size: 13px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  footer {
    padding: 36px 0 72px; color: var(--muted); font-size: 13px; line-height: 1.8;
    border-top: 1px solid var(--line-strong);
  }

  @media (max-width: 720px) {
    .values, .stats { grid-template-columns: repeat(2, 1fr); }
  }
  @media (max-width: 480px) {
    .hero { padding: 60px 0 48px; }
    .hero h1 { font-size: 31px; }
    .hero .lede { font-size: 16px; }
    .section { padding: 48px 0; }
    .values { grid-template-columns: 1fr; }
    .card { padding: 18px 18px 16px; }
    .title { font-size: 19px; }
    .cta { display: block; }
  }
</style>
</head>
<body>

<section class="hero">
  <div class="wrap">
    <span class="eyebrow">Updated ${esc(generated.toISOString().slice(0, 10))}</span>
    <h1>Unfilled job posts are a strong signal of outsourcing demand</h1>
    <p class="lede">
      HireSignal tracks public ATS and web-archive data in near real time to surface
      B2B accounts whose work is piling up behind a hire they cannot close.
    </p>
    <a class="cta" href="#subscribe">Get your free lead report</a>
    ${heroProof ? `<p class="proof">Right now: ${heroProof} That work is not waiting.</p>` : ''}

    <div class="stats" aria-label="Coverage">
      <div><div class="n">${s.total}</div><div class="l">live leads</div></div>
      <div><div class="n hot">${s.hot}</div><div class="l">hot</div></div>
      <div><div class="n">${s.withArchiveEvidence}</div><div class="l">archive&#8209;verified</div></div>
      <div><div class="n">${boardCount}</div><div class="l">boards tracked</div></div>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <h2>Why this data converts</h2>
    <p class="section-sub">Three things you cannot get from a job board.</p>
    <div class="values">
      <div class="value">
        <span class="num">1</span>
        <h3>Verified 90+ day backlogs</h3>
        <p>
          We do not trust the ATS posting date — companies reuse and reset it.
          Age is confirmed against an independent web archive, so a
          "751 days open" claim is evidence, not a guess.
        </p>
      </div>
      <div class="value">
        <span class="num">2</span>
        <h3>The stack that isn't getting done</h3>
        <p>
          Every lead carries the extracted tech stack and how much of the company's
          hiring is concentrated in it. You know what the backlog is made of before
          you write a word.
        </p>
      </div>
      <div class="value">
        <span class="num">3</span>
        <h3>An outreach draft, ready</h3>
        <p>
          Each lead ships with a first-touch draft assembled from the observed
          evidence — the duration, the concentration, the stack. Edit and send.
        </p>
      </div>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <h2>Live B2B outsourcing-opportunity leads</h2>
    <p class="section-sub">
      Detected on the latest scan. Showing ${PUBLIC_PREVIEW_COUNT} of ${s.total}.
    </p>
    <div class="feed">${cards}</div>
    <p class="footnote">
      &#10003; means an independent web archive confirmed the posting existed on that
      date. It is not the ATS's self-reported date.
    </p>

    <div class="gate">
      <div class="n">+${hidden} more</div>
      <p>
        Filtered by stack and role, refreshed daily.<br>
        Tell us which stack you work in and we will open it up for you.
      </p>
    </div>
  </div>
</section>

<section class="section" id="subscribe">
  <div class="wrap">
    <h2>Get weekly leads for your stack</h2>
    <p class="section-sub">
      Tell us the stacks you work in and we will send newly detected leads that match.
    </p>
    <div class="form-card">
      <form id="lead-form">
        <div class="field">
          <label for="stacks">Your stacks or roles</label>
          <input type="text" id="stacks" name="stacks" required
                 placeholder="React, Kubernetes, Django" autocomplete="off">
        </div>
        <div class="field">
          <label for="email">Email (optional)</label>
          <input type="email" id="email" name="email"
                 placeholder="you@company.com" autocomplete="email">
        </div>
        <button type="submit" class="btn-submit">Send me matching leads</button>
      </form>
      <p class="fineprint">
        <strong>How this actually works, plainly:</strong> we are pre-launch and do not
        run a mailing list yet, so submitting opens a pre-filled GitHub issue — that is
        our intake. It is a public thread, so leave the email field blank if you would
        rather not post it, and we will reply on the issue instead. We store nothing
        else about you.
      </p>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <h2>How we decide</h2>
    <p class="section-sub">The method is public, including where it is weak.</p>
    <div class="panel">
      <ol>
        <li>
          <strong>We collect from public ATS APIs.</strong>
          Greenhouse, Lever, Ashby and SmartRecruiters publish their job boards as
          JSON. These are official endpoints, not scraping.
        </li>
        <li>
          <strong>We do not trust the posting date the ATS reports.</strong>
          When a company reuses a requisition the date inflates to years; sometimes it
          resets instead. In one case the ATS reported <code>posted 3 days ago</code>
          for a posting the archive shows existing <code>427 days</code> earlier.
        </li>
        <li>
          <strong>A third-party archive proves existence.</strong>
          If the Wayback Machine captured that exact posting URL, it existed on that
          date — that is not falsifiable. We check the HTTP status of each capture so a
          404 snapshot is never mistaken for evidence.
        </li>
        <li>
          <strong>Evergreen posts are filtered out.</strong>
          "General Application" and "Talent Community" listings are not trying to fill
          a specific seat, so they are not signal.
        </li>
        <li>
          <strong>Roles a freelancer cannot take are removed.</strong>
          A sales or support req stuck for 750 days does not convert into contract work.
          ${s.droppedByRole} leads were dropped on this rule in the latest run.
        </li>
        <li>
          <strong>Weak evidence does not get promoted.</strong>
          Every lead shows its confidence, and below 50% we never assign Hot.
        </li>
      </ol>
    </div>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <h2>What this does not do</h2>
    <p class="section-sub">
      Stated up front, because a tool that hides its limits is not worth trusting.
    </p>
    <ul class="limits">
      <li>
        <strong>Archive coverage is roughly 37%.</strong> The rest carries no external
        proof and is shown at lower confidence. No evidence does not mean "new posting".
      </li>
      <li>
        <strong>Recognition bias.</strong> Better-known companies are archived more
        thoroughly, so leads skew toward them.
      </li>
      <li>
        <strong>Repost and fill signals need time.</strong> The archive bootstraps age,
        but "closed then reopened" only comes from our own daily snapshots. That is why
        the Hot count is small this early.
      </li>
      <li>
        <strong>Stuck does not mean they will outsource.</strong> This gives you a
        reason to reach out. It does not promise a contract.
      </li>
    </ul>
  </div>
</section>

<section class="section">
  <div class="wrap">
    <h2>If you are the one hiring</h2>
    <p>
      We will remove your postings.
      <a href="${REPO_URL}/issues/new?title=${encodeURIComponent('Opt-out request')}" target="_blank" rel="noopener noreferrer">Open an issue</a>
      with your company name or job board URL and it goes into
      <code>seeds/blocklist.json</code>. On the next run the pipeline deletes
      <strong>the accumulated observation history too</strong> — we do not just stop
      collecting and keep what we already have.
    </p>
  </div>
</section>

<footer>
  <div class="wrap">
    Source and method fully public ·
    <a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">github.com/xiangbaej/hiresignal</a><br>
    We do not redistribute job descriptions. Every link points to the original posting.
  </div>
</footer>

<script>
(function () {
  var form = document.getElementById('lead-form');
  if (!form) return;

  /* No form backend yet: submitting opens a pre-filled GitHub issue.
     The issue is public, so the email is included only if the visitor typed one. */
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var stacks = (document.getElementById('stacks').value || '').trim();
    var email = (document.getElementById('email').value || '').trim();
    if (!stacks) return;

    var body = [
      '### Stacks / roles I want leads for',
      stacks,
      '',
      '### What I do',
      '(freelance developer? small agency? — a line is enough)',
      '',
      '### Would you pay for this, and roughly how much per month?',
      '(An honest "no" is just as useful to us.)',
      ''
    ];
    if (email) {
      body.push('### Preferred contact');
      body.push(email);
      body.push('');
    }

    var url = '${REPO_URL}/issues/new' +
      '?title=' + encodeURIComponent('Lead request: ' + stacks) +
      '&body=' + encodeURIComponent(body.join('\\n'));
    window.open(url, '_blank', 'noopener');
  });
})();
</script>
</body>
</html>
`;
}

/* ================================================================== *
 * 실행
 * ================================================================== */

async function main() {
  const raw = await readFile(path.join(DATA_DIR, 'leads.json'), 'utf8');
  const data = JSON.parse(raw) as LeadsFile;

  // 내부용 전체 리포트
  const internalPath = path.join(DATA_DIR, 'report.html');
  await writeFile(`${internalPath}.tmp`, renderHtml(data), 'utf8');
  await rename(`${internalPath}.tmp`, internalPath);

  // 공개용 티저. GitHub Pages 가 main /docs 를 서빙한다.
  const docsDir = path.join(ROOT, 'docs');
  await mkdir(docsDir, { recursive: true });
  const publicPath = path.join(docsDir, 'index.html');
  await writeFile(`${publicPath}.tmp`, renderPublicHtml(data), 'utf8');
  await rename(`${publicPath}.tmp`, publicPath);

  console.log(
    `\ndata/report.html   내부용 전체 ${data.leads.length}건 ` +
      `(hot ${data.summary.hot} / warm ${data.summary.warm})\n` +
      `docs/index.html    공개용 티저 ${Math.min(PUBLIC_PREVIEW_COUNT, data.leads.length)}건 + 액세스 요청 CTA\n`,
  );
}

main().catch((e) => {
  console.error('오류:', e);
  process.exit(1);
});
