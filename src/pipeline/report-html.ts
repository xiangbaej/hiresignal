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

import { readFile, rename, writeFile } from 'node:fs/promises';
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

async function main() {
  const raw = await readFile(path.join(DATA_DIR, 'leads.json'), 'utf8');
  const data = JSON.parse(raw) as LeadsFile;

  const html = renderHtml(data);
  const outPath = path.join(DATA_DIR, 'report.html');
  const tmp = `${outPath}.tmp`;
  await writeFile(tmp, html, 'utf8');
  await rename(tmp, outPath);

  console.log(
    `\ndata/report.html 생성: 리드 ${data.leads.length}건 ` +
      `(hot ${data.summary.hot} / warm ${data.summary.warm})\n` +
      `브라우저로 열어 확인하세요.\n`,
  );
}

main().catch((e) => {
  console.error('오류:', e);
  process.exit(1);
});
