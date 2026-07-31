/**
 * 정적 HTML 리드 리포트 생성.
 *
 *   npx tsx src/pipeline/report-html.ts
 *   → data/report.html (브라우저로 열면 됨)
 *
 * ── 왜 지금 이걸 만드는가 ──
 *
 * 현재 산출물은 data/leads.json 하나다. 기계가 읽는 형식이라 사람에게 보여줄 수
 * 없고, 보여줄 수 없으면 검증도 판매도 불가능하다. 이 사업의 다음 관문은 기술이
 * 아니라 "프리랜서 5명에게 이 목록을 보여주고 돈을 낼지 묻는 것"이다. 그 대화에
 * 필요한 최소 산출물이 이것이다.
 *
 * 의존성을 추가하지 않는다. 단일 HTML 파일로 만들어 이메일 첨부·정적 호스팅·
 * 로컬 열기가 모두 되게 한다. 이후 웹앱으로 갈 때 이 화면이 명세가 된다.
 *
 * 공고 본문은 담지 않는다. ATS의 job board API는 자사 채용 페이지 구축용으로
 * 제공된 것이므로 본문을 재배포하지 않고 원문 링크로 보낸다. 우리가 파는 것은
 * 본문이 아니라 "어느 공고가 왜 기회인가"라는 판단이다.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA_DIR = path.join(ROOT, 'data');

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
  };
  leads: Lead[];
}

/** XSS 방지. 공고 제목·회사명은 외부 입력이므로 반드시 이스케이프한다. */
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** URL은 이스케이프만으로 부족하다. javascript: 스킴 등을 차단한다. */
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

function renderRow(lead: Lead): string {
  const age =
    lead.ageDays === null
      ? '<span class="muted">—</span>'
      : `${lead.ageDays}일${lead.ageFromArchive ? '<abbr title="Wayback Machine 아카이브가 증명한 값입니다">*</abbr>' : ''}`;

  const tags = lead.tags
    .map((t) => `<span class="tag">${esc(t)}</span>`)
    .join('');

  const reasons = lead.reasons
    .map((r) => `<li>${esc(r)}</li>`)
    .join('');

  const location = lead.locationRaw ? esc(lead.locationRaw) : '';
  const workplace =
    lead.workplaceType && lead.workplaceType !== 'unknown'
      ? `<span class="wp">${esc(lead.workplaceType)}</span>`
      : '';

  return `
<tr data-grade="${esc(lead.grade)}" data-role="${esc(lead.roleCategory)}" data-tags="${esc(lead.tags.join(' '))}">
  <td class="c-grade"><span class="badge badge-${esc(lead.grade)}">${esc(lead.grade)}</span></td>
  <td class="c-score"><strong>${esc(lead.score)}</strong><span class="muted">/${Math.round(lead.confidence * 100)}%</span></td>
  <td class="c-age">${age}</td>
  <td class="c-company">
    <div class="company">${esc(lead.company)}</div>
    <div class="muted small">${esc(lead.board)}</div>
  </td>
  <td class="c-title">
    <a href="${safeUrl(lead.jobUrl)}" target="_blank" rel="noopener noreferrer">${esc(lead.title)}</a>
    <div class="meta">
      <span class="role">${esc(ROLE_LABELS[lead.roleCategory] ?? lead.roleCategory)}</span>
      ${workplace}
      ${location ? `<span class="loc">${location}</span>` : ''}
    </div>
    <div class="tags">${tags}</div>
    <details>
      <summary>왜 이 리드인가 (신호 ${esc(lead.signals)}개)</summary>
      <ul>${reasons}</ul>
    </details>
  </td>
</tr>`;
}

function renderHtml(data: LeadsFile): string {
  const s = data.summary;
  const generated = new Date(data.generatedAt);

  const roleChips = Object.entries(s.byRole)
    .sort((a, b) => b[1] - a[1])
    .map(
      ([role, n]) =>
        `<button type="button" class="chip" data-filter-role="${esc(role)}">${esc(ROLE_LABELS[role] ?? role)} <span class="chip-n">${n}</span></button>`,
    )
    .join('');

  const allTags = new Map<string, number>();
  for (const lead of data.leads) {
    for (const tag of lead.tags) allTags.set(tag, (allTags.get(tag) ?? 0) + 1);
  }
  const topTags = [...allTags.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(
      ([tag, n]) =>
        `<button type="button" class="chip" data-filter-tag="${esc(tag)}">${esc(tag)} <span class="chip-n">${n}</span></button>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HireSignal — 리드 리포트 ${esc(generated.toISOString().slice(0, 10))}</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --line: #262b35;
    --fg: #e6e9ef; --muted: #8b93a7; --accent: #5b8cff;
    --hot: #ff6b4a; --warm: #f0b429;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.6 -apple-system, "Segoe UI", "Malgun Gothic", system-ui, sans-serif;
  }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 32px 20px 80px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; }
  .card .n { font-size: 26px; font-weight: 650; }
  .card .l { color: var(--muted); font-size: 12px; }
  .filters { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 20px; }
  .filters h2 { font-size: 13px; color: var(--muted); margin: 0 0 8px; font-weight: 500; text-transform: uppercase; letter-spacing: .04em; }
  .row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
  .row:last-child { margin-bottom: 0; }
  .chip {
    background: #1e2230; color: var(--fg); border: 1px solid var(--line);
    border-radius: 999px; padding: 5px 11px; font-size: 12.5px; cursor: pointer; font-family: inherit;
  }
  .chip:hover { border-color: var(--accent); }
  .chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
  .chip-n { color: var(--muted); margin-left: 3px; }
  .chip[aria-pressed="true"] .chip-n { color: #dbe4ff; }
  input[type="search"] {
    width: 100%; max-width: 380px; padding: 8px 12px; border-radius: 8px;
    border: 1px solid var(--line); background: #1e2230; color: var(--fg); font: inherit;
  }
  table { width: 100%; border-collapse: collapse; }
  thead th {
    text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em;
    color: var(--muted); font-weight: 500; padding: 8px 10px; border-bottom: 1px solid var(--line);
  }
  tbody td { padding: 14px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tbody tr:hover { background: #14171e; }
  .c-grade { width: 62px; } .c-score { width: 82px; } .c-age { width: 92px; } .c-company { width: 170px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 650; text-transform: uppercase; }
  .badge-hot { background: rgba(255,107,74,.16); color: var(--hot); }
  .badge-warm { background: rgba(240,180,41,.14); color: var(--warm); }
  .muted { color: var(--muted); } .small { font-size: 11.5px; }
  .company { font-weight: 600; }
  .c-title a { color: var(--fg); text-decoration: none; font-weight: 550; }
  .c-title a:hover { color: var(--accent); text-decoration: underline; }
  .meta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; font-size: 11.5px; color: var(--muted); }
  .tags { margin-top: 6px; display: flex; gap: 4px; flex-wrap: wrap; }
  .tag { background: #1e2230; border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px; font-size: 11px; color: #b6c0d4; }
  details { margin-top: 8px; }
  summary { cursor: pointer; font-size: 12px; color: var(--accent); }
  details ul { margin: 6px 0 0; padding-left: 18px; font-size: 12.5px; color: #c2cadb; }
  abbr { text-decoration: none; color: var(--accent); cursor: help; }
  .empty { padding: 40px; text-align: center; color: var(--muted); }
  .note { margin-top: 28px; padding: 14px 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; font-size: 12.5px; color: var(--muted); }
  .note strong { color: var(--fg); }
  @media (max-width: 720px) {
    .c-company, .c-age { display: none; }
  }
</style>
</head>
<body>
<div class="wrap">
  <h1>HireSignal 리드 리포트</h1>
  <p class="sub">
    생성 ${esc(generated.toISOString().replace('T', ' ').slice(0, 16))} UTC ·
    스캔 ${esc(data.runId.slice(0, 8))}
  </p>

  <div class="cards">
    <div class="card"><div class="n">${s.total}</div><div class="l">전체 리드</div></div>
    <div class="card"><div class="n" style="color:var(--hot)">${s.hot}</div><div class="l">Hot</div></div>
    <div class="card"><div class="n" style="color:var(--warm)">${s.warm}</div><div class="l">Warm</div></div>
    <div class="card"><div class="n">${s.withArchiveEvidence}</div><div class="l">아카이브 증거 확보</div></div>
    <div class="card"><div class="n">${s.droppedByRole}</div><div class="l">수임 불가 직군 제외</div></div>
  </div>

  <div class="filters">
    <h2>직군</h2>
    <div class="row" id="roleFilters">${roleChips}</div>
    <h2>기술 스택</h2>
    <div class="row" id="tagFilters">${topTags}</div>
    <h2>검색</h2>
    <div class="row">
      <label for="q" class="muted small" style="width:100%">회사명 또는 공고 제목</label>
      <input type="search" id="q" placeholder="예: react, baseten, platform" aria-label="회사명 또는 공고 제목 검색">
    </div>
  </div>

  <table>
    <caption class="muted small" style="text-align:left;padding:0 0 8px">
      점수 아래 백분율은 신뢰도(사용 가능한 신호의 비중)입니다. 나이의 <abbr title="Wayback Machine 아카이브가 증명한 값">*</abbr>는 제3자 아카이브가 증명한 값입니다.
    </caption>
    <thead>
      <tr>
        <th scope="col">등급</th>
        <th scope="col">점수</th>
        <th scope="col">경과</th>
        <th scope="col">회사</th>
        <th scope="col">공고</th>
      </tr>
    </thead>
    <tbody id="rows">${data.leads.map(renderRow).join('')}</tbody>
  </table>
  <div class="empty" id="empty" hidden>조건에 맞는 리드가 없습니다.</div>

  <div class="note">
    <strong>이 리포트를 읽는 법.</strong>
    점수는 "이 공고가 얼마나 채워지지 않고 있는가"를 측정합니다. 관측 이력이 짧은 초기에는
    신뢰도가 낮게 표시되며, 신뢰도 50% 미만에서는 Hot 등급을 부여하지 않습니다.
    영업·관리·고객지원 등 프리랜서가 수임할 수 없는 직군은 신호가 강해도 제외했습니다
    (이번 회차 ${s.droppedByRole}건).
  </div>
</div>

<script>
(function () {
  var rows = Array.prototype.slice.call(document.querySelectorAll('#rows tr'));
  var q = document.getElementById('q');
  var empty = document.getElementById('empty');
  var activeRoles = new Set();
  var activeTags = new Set();

  function apply() {
    var term = q.value.trim().toLowerCase();
    var shown = 0;
    rows.forEach(function (tr) {
      var role = tr.getAttribute('data-role') || '';
      var tags = (tr.getAttribute('data-tags') || '').split(' ');
      var text = tr.textContent.toLowerCase();

      var okRole = activeRoles.size === 0 || activeRoles.has(role);
      var okTag = activeTags.size === 0 || tags.some(function (t) { return activeTags.has(t); });
      var okTerm = term === '' || text.indexOf(term) !== -1;
      var visible = okRole && okTag && okTerm;

      tr.hidden = !visible;
      if (visible) shown++;
    });
    empty.hidden = shown !== 0;
  }

  function bind(containerId, attr, set) {
    document.getElementById(containerId).addEventListener('click', function (e) {
      var btn = e.target.closest('.chip');
      if (!btn) return;
      var value = btn.getAttribute(attr);
      if (set.has(value)) { set.delete(value); btn.setAttribute('aria-pressed', 'false'); }
      else { set.add(value); btn.setAttribute('aria-pressed', 'true'); }
      apply();
    });
  }

  document.querySelectorAll('.chip').forEach(function (c) { c.setAttribute('aria-pressed', 'false'); });
  bind('roleFilters', 'data-filter-role', activeRoles);
  bind('tagFilters', 'data-filter-tag', activeTags);
  q.addEventListener('input', apply);
})();
</script>
</body>
</html>
`;
}

/* ================================================================== *
 * 공개 티저 페이지
 * ================================================================== */

/** 공개 페이지에서 무료로 보여줄 리드 수 */
const PUBLIC_PREVIEW_COUNT = 20;

const REPO_URL = 'https://github.com/xiangbaej/hiresignal';

/**
 * 공개용 페이지를 만든다.
 *
 * ── 왜 이걸 만드는가 ──
 *
 * 이 사업의 다음 관문은 "프리랜서가 이 리드에 돈을 낼 것인가"인데, 아웃바운드로
 * 물어볼 수 없는 상황이다. 그래서 반대 방향으로 검증한다 — 공개해 두고 관심을
 * 측정한다. 이메일 폼을 호스팅할 인프라가 없으므로 GitHub Issue를 신청 창구로
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

  const issueUrl =
    `${REPO_URL}/issues/new?title=${encodeURIComponent('Access request')}` +
    `&body=${encodeURIComponent(
      [
        '### What do you do?',
        '(예: 프리랜스 백엔드 개발자 / 3인 개발 에이전시)',
        '',
        '### Which stacks or roles do you want leads for?',
        '(예: React Native, Kubernetes, Django)',
        '',
        '### Would you pay for this? If so, roughly how much per month?',
        '(솔직하게 답해 주세요. 안 낸다는 답도 저희에게 유용합니다.)',
        '',
      ].join('\n'),
    )}`;

  const rows = preview
    .map((lead) => {
      const age =
        lead.ageDays === null
          ? '—'
          : `${lead.ageDays}일${lead.ageFromArchive ? '<abbr title="Wayback Machine 아카이브가 증명한 값">*</abbr>' : ''}`;
      const tags = lead.tags
        .slice(0, 5)
        .map((t) => `<span class="tag">${esc(t)}</span>`)
        .join('');
      return `
<tr>
  <td><span class="badge badge-${esc(lead.grade)}">${esc(lead.grade)}</span></td>
  <td class="num">${age}</td>
  <td><strong>${esc(lead.company)}</strong></td>
  <td>
    <a href="${safeUrl(lead.jobUrl)}" target="_blank" rel="noopener noreferrer">${esc(lead.title)}</a>
    <div class="tags">${tags}</div>
    <details><summary>근거</summary><ul>${lead.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></details>
  </td>
</tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HireSignal — 채워지지 않는 채용 공고에서 외주 기회를 찾습니다</title>
<meta name="description" content="ATS 공개 API와 Wayback 아카이브를 결합해, 오래 채워지지 않는 채용 공고를 프리랜서 외주 기회로 변환합니다.">
<style>
  :root { --bg:#0f1115; --panel:#171a21; --line:#262b35; --fg:#e6e9ef; --muted:#8b93a7; --accent:#5b8cff; --hot:#ff6b4a; --warm:#f0b429; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.7 -apple-system,"Segoe UI","Malgun Gothic",system-ui,sans-serif; }
  .wrap { max-width:860px; margin:0 auto; padding:56px 20px 100px; }
  h1 { font-size:30px; line-height:1.3; margin:0 0 12px; letter-spacing:-.01em; }
  h2 { font-size:19px; margin:44px 0 12px; }
  h3 { font-size:15px; margin:24px 0 6px; color:var(--fg); }
  p { color:#c6cddc; }
  .lede { font-size:18px; color:#c6cddc; margin:0 0 8px; }
  .stamp { color:var(--muted); font-size:13px; margin-bottom:32px; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; margin:24px 0 8px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:14px; }
  .card .n { font-size:24px; font-weight:650; }
  .card .l { color:var(--muted); font-size:12px; }
  table { width:100%; border-collapse:collapse; margin-top:12px; }
  th { text-align:left; font-size:11.5px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); font-weight:500; padding:8px; border-bottom:1px solid var(--line); }
  td { padding:13px 8px; border-bottom:1px solid var(--line); vertical-align:top; font-size:14.5px; }
  td.num { white-space:nowrap; color:#c6cddc; }
  a { color:var(--accent); }
  td a { color:var(--fg); text-decoration:none; font-weight:550; }
  td a:hover { color:var(--accent); text-decoration:underline; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:650; text-transform:uppercase; }
  .badge-hot { background:rgba(255,107,74,.16); color:var(--hot); }
  .badge-warm { background:rgba(240,180,41,.14); color:var(--warm); }
  .tags { margin-top:5px; display:flex; gap:4px; flex-wrap:wrap; }
  .tag { background:#1e2230; border:1px solid var(--line); border-radius:4px; padding:1px 6px; font-size:11px; color:#b6c0d4; }
  details { margin-top:6px; } summary { cursor:pointer; font-size:12px; color:var(--accent); }
  details ul { margin:6px 0 0; padding-left:18px; font-size:13px; color:#c2cadb; }
  .gate { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:24px; margin:24px 0; text-align:center; }
  .gate .n { font-size:30px; font-weight:650; }
  .cta { display:inline-block; background:var(--accent); color:#fff; text-decoration:none; font-weight:600; padding:11px 22px; border-radius:8px; margin-top:12px; }
  .cta:hover { background:#4a7bf0; }
  .method { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:20px 24px; }
  .method ol { padding-left:20px; } .method li { margin-bottom:10px; color:#c6cddc; }
  .limits li { margin-bottom:8px; color:#c6cddc; }
  code { background:#1e2230; border:1px solid var(--line); border-radius:4px; padding:1px 5px; font-size:13px; }
  abbr { text-decoration:none; color:var(--accent); cursor:help; }
  footer { margin-top:56px; padding-top:20px; border-top:1px solid var(--line); color:var(--muted); font-size:13px; }
</style>
</head>
<body>
<main class="wrap">
  <h1>채워지지 않는 채용 공고는<br>외주 발주 신호입니다</h1>
  <p class="lede">
    어떤 회사가 Kubernetes 엔지니어를 750일째 못 구하고 있다면, 그 일은 어딘가에서
    처리되어야 합니다. HireSignal은 공개 ATS API와 Wayback 아카이브를 결합해 그런
    공고를 찾아냅니다.
  </p>
  <p class="stamp">
    갱신 ${esc(generated.toISOString().slice(0, 10))} · 추적 보드 ${188}개 ·
    전량 공개 데이터 기반
  </p>

  <div class="cards">
    <div class="card"><div class="n">${s.total}</div><div class="l">현재 리드</div></div>
    <div class="card"><div class="n" style="color:var(--hot)">${s.hot}</div><div class="l">Hot</div></div>
    <div class="card"><div class="n">${s.withArchiveEvidence}</div><div class="l">아카이브 증거 확보</div></div>
    <div class="card"><div class="n">${s.droppedByRole}</div><div class="l">수임 불가 직군 제외</div></div>
  </div>

  <h2>지금 열려 있는 기회 ${PUBLIC_PREVIEW_COUNT}건</h2>
  <table>
    <thead><tr><th scope="col">등급</th><th scope="col">경과</th><th scope="col">회사</th><th scope="col">공고</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="font-size:13px;color:var(--muted)">
    <abbr title="Wayback Machine 아카이브가 증명한 값">*</abbr> 표시는 제3자 아카이브가
    그 시점에 공고가 존재했음을 증명한 값입니다. ATS가 보고하는 게시일이 아닙니다.
  </p>

  <div class="gate">
    <div class="n">+${hidden}건</div>
    <p>스택·직군별 전체 목록과 매일 갱신되는 알림을 준비하고 있습니다.<br>
       어떤 스택의 리드가 필요한지 알려주시면 우선 열어드립니다.</p>
    <a class="cta" href="${esc(issueUrl)}" target="_blank" rel="noopener noreferrer">액세스 요청하기</a>
    <p style="font-size:12.5px;color:var(--muted);margin-top:14px">
      GitHub 이슈로 열립니다. 이메일 수집을 하지 않습니다.
    </p>
  </div>

  <h2>어떻게 판단하는가</h2>
  <div class="method">
    <ol>
      <li>
        <strong>공개 ATS API에서 공고를 수집합니다.</strong>
        Greenhouse·Lever·Ashby·SmartRecruiters가 채용 보드를 JSON으로 공개합니다.
        스크래핑이 아니라 공식 엔드포인트입니다.
      </li>
      <li>
        <strong>ATS가 보고하는 게시일은 신뢰하지 않습니다.</strong>
        회사가 requisition을 재사용하면 게시일이 수년으로 부풀려지고, 반대로 초기화되기도
        합니다. 한 사례에서는 ATS가 <code>3일 전 게시</code>라고 표시한 공고가
        아카이브에는 <code>427일 전</code>부터 존재했습니다.
      </li>
      <li>
        <strong>제3자 아카이브로 존재를 증명합니다.</strong>
        Wayback Machine에 해당 공고 URL이 캡처되어 있으면 그 시점에 존재했다는 반증
        불가능한 증거가 됩니다. 404 캡처를 증거로 오인하지 않도록 응답 상태코드까지
        확인합니다.
      </li>
      <li>
        <strong>상시 채용 공고를 걸러냅니다.</strong>
        "General Application", "Talent Community" 같은 인재풀 공고는 특정 자리를
        채우려는 게 아니므로 신호가 아닙니다.
      </li>
      <li>
        <strong>프리랜서가 수임할 수 없는 직무를 제외합니다.</strong>
        영업·관리·고객지원 공고가 750일 막혀 있어도 외주로 전환되지 않습니다.
        이번 회차에서 ${s.droppedByRole}건을 이 기준으로 제외했습니다.
      </li>
      <li>
        <strong>근거가 부족하면 등급을 올리지 않습니다.</strong>
        각 리드에 신뢰도를 함께 표시하고, 신뢰도가 낮으면 Hot을 부여하지 않습니다.
      </li>
    </ol>
  </div>

  <h2>알아두실 한계</h2>
  <ul class="limits">
    <li>
      아카이브 커버리지는 약 <strong>37%</strong>입니다. 나머지는 증거를 얻지 못했고,
      그 경우 신뢰도를 낮춰 표시합니다. 증거가 없다는 것이 "새 공고"라는 뜻은 아닙니다.
    </li>
    <li>
      아카이브는 인지도 높은 회사가 더 잘 남습니다. 따라서 리드가 알려진 회사로
      편향됩니다.
    </li>
    <li>
      "재게시"와 "충원" 신호는 자체 관측이 쌓여야 계산됩니다. 관측을 시작한 지
      얼마 되지 않아 현재 Hot 등급 수는 구조적으로 적습니다.
    </li>
    <li>
      막혀 있다는 것이 외주를 준다는 뜻은 아닙니다. 이 도구는 접근할 근거를 주지만
      수주를 보장하지 않습니다.
    </li>
  </ul>

  <footer>
    소스와 방법론 전체 공개 · <a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">github.com/xiangbaej/hiresignal</a><br>
    공고 본문은 재배포하지 않습니다. 모든 링크는 원문으로 연결됩니다.
  </footer>
</main>
</body>
</html>
`;
}

async function main() {
  const raw = await readFile(path.join(DATA_DIR, 'leads.json'), 'utf8');
  const data = JSON.parse(raw) as LeadsFile;

  // 내부용 전체 리포트
  const internalPath = path.join(DATA_DIR, 'report.html');
  await writeFile(`${internalPath}.tmp`, renderHtml(data), 'utf8');
  await rename(`${internalPath}.tmp`, internalPath);

  // 공개용 티저. GitHub Pages를 /docs 에서 서빙하도록 설정하면 바로 노출된다.
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
