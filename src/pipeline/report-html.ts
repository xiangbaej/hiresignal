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
  roles: Array<{
    title: string;
    jobUrl: string;
    ageDays: number | null;
    ageFromArchive: boolean;
    grade: string;
    tags: string[];
  }>;
}

/** 리드를 회사 단위로 묶는다. 보드가 다르면 다른 회사로 취급한다. */
function groupByCompany(leads: Lead[]): CompanyGroup[] {
  const map = new Map<string, CompanyGroup>();

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
        roles: [],
      };
      map.set(key, g);
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
    g.roles.push({
      title: lead.title,
      jobUrl: lead.jobUrl,
      ageDays: lead.ageDays,
      ageFromArchive: lead.ageFromArchive,
      grade: lead.grade,
      tags: lead.tags,
    });
  }

  for (const g of map.values()) {
    // 오래 막힌 자리를 먼저 보여준다. 제안 각도를 잡을 때 그게 시작점이다.
    g.roles.sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
    g.searchBlob = `${g.company} ${g.roles.map((r) => r.title).join(' ')} ${g.tags.join(' ')}`
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
    --hot: #f04452;
    --hot-weak: #ffeceb;
    --warn: #ff9500;
    --warn-weak: #fff4e6;
    --warn-fg: #b26a00;
    --radius: 20px;
    --shadow: 0 1px 2px rgba(0, 27, 55, .04), 0 6px 20px rgba(0, 27, 55, .05);
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
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
  .grade-hot { background: var(--hot); color: #fff; }
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

  const roles = g.roles
    .map((r) => {
      const age =
        r.ageDays === null
          ? '<span class="muted">—</span>'
          : `${r.ageDays}일${r.ageFromArchive ? '&#10003;' : ''}`;
      return (
        `<li><span class="role-age">${age}</span>` +
        `<a href="${safeUrl(r.jobUrl)}" target="_blank" rel="noopener noreferrer">${esc(r.title)}</a></li>`
      );
    })
    .join('');

  return `
<article class="group-card" data-groups="${esc([...g.tabGroups].join(' '))}"
         data-search="${esc(g.searchBlob)}" data-count="${g.count}"
         data-age="${esc(g.maxAge ?? 0)}" data-rel="${g.topRel}"
         data-company="${esc(g.company)}"
         data-roles="${esc(JSON.stringify(g.roles.map((r) => r.title)))}"
         data-tags="${esc(g.tags.slice(0, 4).join(', '))}">
  <div class="card-top">
    <span class="sig sig-${ageTone}">${esc(ageText)}</span>
    <span class="group-n">${g.count}개 자리${g.hotCount > 0 ? ` · hot ${g.hotCount}` : ''}</span>
  </div>

  <h2 class="title title-company">${esc(g.company)}</h2>
  <div class="meta">${esc(g.board)}</div>

  ${tags ? `<div class="tags">${tags}</div>` : ''}

  <details class="why"${g.count > 1 ? ' open' : ''}>
    <summary>막혀 있는 자리 ${g.count}개</summary>
    <ul class="role-list">${roles}</ul>
  </details>

  <div class="card-cta">
    <button type="button" class="btn-primary" data-gdraft="${index}">
      회사 단위 콜드메일 초안 <span aria-hidden="true">&rarr;</span>
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
         data-search="${esc(`${lead.company} ${lead.title} ${lead.tags.join(' ')}`.toLowerCase())}"
         data-company="${esc(lead.company)}" data-title="${esc(lead.title)}"
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

function renderHtml(data: LeadsFile): string {
  const s = data.summary;
  const generated = new Date(data.generatedAt);

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
  .wrap { max-width: 720px; margin: 0 auto; padding: 0 16px 96px; }

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
  .tab:hover { background: #e8ebee; }
  .tab:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
  .tab[aria-pressed="true"] { background: var(--fg); color: #fff; }
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

  /* 검색 + 보기 전환 + 정렬 */
  .controls { display: flex; gap: 8px; margin-top: 10px; align-items: stretch; }
  .search { flex: 1; min-width: 0; }
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
  .result-count { font-size: 12.5px; color: var(--muted); margin: 14px 0 0; }

  .feed { display: flex; flex-direction: column; gap: 12px; margin-top: 10px; }

  /* CTA: 카드 우측 하단 단일 메인 버튼 */
  .card-cta { display: flex; justify-content: flex-end; margin-top: 16px; }
  .btn-primary {
    border: 0; cursor: pointer; font: inherit; font-size: 14.5px; font-weight: 700;
    color: #fff; background: var(--primary); border-radius: 12px; padding: 12px 18px;
    transition: background .12s, transform .06s;
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
  .btn-ghost:hover { background: #d8ebff; }
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
  .title-company { font-size: 22px; margin-bottom: 2px; }
  .role-list { list-style: none; padding: 14px 16px; margin: 10px 0 0; }
  .role-list li {
    display: flex; gap: 10px; align-items: baseline; padding: 5px 0;
    font-size: 14px;
  }
  .role-list li + li { border-top: 1px solid #eef1f4; padding-top: 8px; margin-top: 3px; }
  .role-age {
    flex: 0 0 74px; font-size: 12.5px; font-weight: 700; color: var(--fg2);
    font-variant-numeric: tabular-nums;
  }
  .role-list a { color: var(--fg); text-decoration: none; font-weight: 600; }
  .role-list a:hover { color: var(--primary); text-decoration: underline; }
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

  .empty { text-align: center; color: var(--muted); padding: 60px 20px; font-size: 14px; }
  .note {
    margin-top: 20px; background: var(--card); border-radius: var(--radius);
    box-shadow: var(--shadow); padding: 20px 22px; font-size: 13px; color: var(--fg2);
  }
  .note strong { color: var(--fg); }

  @media (max-width: 480px) {
    .card { padding: 18px 18px 16px; }
    .title { font-size: 19px; }
    .summary { padding: 16px; }
    .card-cta .btn-primary { width: 100%; }
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
      <label class="sort">
        <span class="sr-only">정렬</span>
        <select id="sort" aria-label="정렬 기준">
          <option value="default">기본 정렬</option>
          <option value="age">오래된 순</option>
          <option value="count">자리 많은 순</option>
          <option value="company">회사명</option>
        </select>
      </label>
    </div>
  </div>

  <p class="result-count" id="count" role="status" aria-live="polite"></p>

  <div class="feed" id="groups">${groupCards}</div>
  <div class="feed" id="feed" hidden>${cards}</div>
  <div class="empty" id="empty" hidden>조건에 맞는 리드가 없습니다.</div>

  <details class="audit">
    <summary>직군 필터가 제외한 ${s.droppedByRole}건 감사</summary>
    <p class="audit-note">
      이 필터는 정밀도를 위해 재현율을 희생합니다. 수임 가능한 직무를 잘못 걷어내면
      리드가 조용히 사라지므로, 무엇을 버렸는지 확인할 수 있어야 합니다.
      <code>other</code> 에 개발 직무가 보이면 <code>src/lib/signals/role.ts</code> 의
      분류기를 고쳐야 한다는 신호입니다.
    </p>
    <div class="drops">${droppedRows}</div>
  </details>

  <div class="note">
    <strong>이 리포트를 읽는 법.</strong>
    기본은 <strong>회사별</strong> 보기입니다. 프리랜서는 공고가 아니라 회사에 제안하고,
    같은 회사의 여러 자리가 흩어져 있으면 같은 곳에 중복으로 연락하게 됩니다.
    경과일은 "얼마나 채워지지 않고 있는가"이며 &#10003; 는 제3자 아카이브가 그 시점의
    존재를 증명한 값입니다. 신뢰도 50% 미만에서는 Hot 을 부여하지 않습니다.
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
  var segs = Array.prototype.slice.call(document.querySelectorAll('.seg-btn'));
  var q = document.getElementById('q');
  var sortSel = document.getElementById('sort');
  var empty = document.getElementById('empty');
  var count = document.getElementById('count');

  var activeTab = 'all';
  var view = 'company';

  function matchesTab(el) {
    if (activeTab === 'all') return true;
    if (view === 'lead') return el.getAttribute('data-group') === activeTab;
    /* 회사는 여러 직군을 동시에 채용할 수 있으므로 공백 구분 목록에 포함되는지 본다. */
    return (el.getAttribute('data-groups') || '').split(' ').indexOf(activeTab) !== -1;
  }

  function apply() {
    var term = q.value.trim().toLowerCase();
    var list = view === 'lead' ? leadCards : groupCards;
    var shown = 0;
    list.forEach(function (el) {
      var visible = matchesTab(el) &&
        (term === '' || (el.getAttribute('data-search') || '').indexOf(term) !== -1);
      el.hidden = !visible;
      if (visible) shown++;
    });
    empty.hidden = shown !== 0;
    count.textContent = view === 'lead'
      ? shown + '개 공고 (전체 ' + leadCards.length + ')'
      : shown + '개 회사 (전체 ' + groupCards.length + ')';
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

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      activeTab = tab.getAttribute('data-tab');
      tabs.forEach(function (t) {
        t.setAttribute('aria-pressed', t === tab ? 'true' : 'false');
      });
      apply();
    });
  });
  segs.forEach(function (s) {
    s.addEventListener('click', function () { setView(s.getAttribute('data-view')); });
  });
  sortSel.addEventListener('change', sortNow);
  q.addEventListener('input', apply);
  setView('company');

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

    var lines = [];
    lines.push('Subject: ' + n + ' open ' + (n === 1 ? 'role' : 'roles') +
      ' at ' + company + ' \\u2014 interim help?');
    lines.push('');
    lines.push('Hi ' + company + ' team,');
    lines.push('');
    lines.push(
      'From the outside it looks like ' + n + ' ' + (n === 1 ? 'position' : 'positions') +
      ' on your team ' + (n === 1 ? 'has' : 'have') + ' been open for a while' +
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
        if (box.hidden) {
          ta.value = builder(openBtn.closest('article'));
          box.hidden = false;
          openBtn.setAttribute('data-label', openBtn.innerHTML);
          openBtn.textContent = '초안 닫기';
          ta.focus();
          ta.setSelectionRange(0, 0);
        } else {
          box.hidden = true;
          openBtn.innerHTML = openBtn.getAttribute('data-label') || '초안 생성';
        }
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
      if (box.hidden) {
        ta.value = buildDraft(draftBtn.closest('.card'));
        box.hidden = false;
        draftBtn.textContent = '초안 닫기';
        ta.focus();
        ta.setSelectionRange(0, 0);
      } else {
        box.hidden = true;
        draftBtn.innerHTML = '콜드메일 초안 생성 <span aria-hidden="true">&rarr;</span>';
      }
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
  .section + .section { border-top: 1px solid #e9ecef; }
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
    display: inline-block; background: var(--primary); color: #fff; text-decoration: none;
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
    font-weight: 700; color: #fff; background: var(--primary); border-radius: 14px;
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
    border-top: 1px solid #e9ecef;
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
