/**
 * 생성물 UI 행동 테스트. 두 산출물을 모두 본다.
 *
 *   npm run ui:test
 *
 *   data/report.html   운영자용 내부 리포트 (상태 기계)
 *   docs/index.html    공개 티저 (이 사업의 검증 장치)
 *
 * ── 왜 필요한가 ──
 *
 * data/report.html 의 인라인 스크립트는 이제 상태 기계다. 필터 4종(탭·검색·Hot·
 * 미연락)이 합성되고, 그 상태가 URL 해시로 왕복하며, 연락 이력은 localStorage 에
 * 남고, 보기 전환이 정렬과 필터를 함께 되돌린다. 이 정도 결합은 생성물을 정규식으로
 * 훑어서는 검증되지 않는다 - "속성이 있다"와 "눌렀을 때 의도대로 동작한다"는 다른
 * 주장이다.
 *
 * 실제로 정적 검사만 하던 동안 다음 결함들이 사람 눈에만 걸렸다.
 *   - `.feed { display:flex }` 가 [hidden] 을 덮어 두 피드가 동시에 렌더된 것
 *   - 셀렉트 정렬 변경이 URL 에 저장되지 않은 것(단축키 경로만 저장)
 * 그리고 이 테스트를 붙인 첫 실행에서 세 건이 더 드러났다.
 *   - setView 가 Hot·미연락 필터의 aria-pressed 까지 덮어 필터가 조용히 꺼진 것
 *   - j/k 가 화면 순서가 아니라 원래 배열 순서로 이동한 것
 *   - 초안을 열면 포커스가 textarea 로 가서 키보드로 빠져나올 수 없던 것
 * 전부 "클릭하고 결과를 본다"로만 잡히는 종류다.
 *
 * 공개 티저도 함께 본다. 내부 리포트가 깨지면 운영자만 불편하지만, 공개 페이지가
 * 깨지면 액세스 요청 수로 수요를 측정하는 이 사업의 검증 장치 자체가 멈춘다.
 *
 * ── 방법 ──
 *
 * jsdom 에 생성물을 그대로 올리고 인라인 스크립트를 실행한 뒤, 실제 클릭과
 * 키입력을 보내 화면 상태를 읽는다. 산출물을 대상으로 하므로 렌더 코드와 브라우저
 * 동작 사이의 간극이 남지 않는다.
 *
 * 테스트 프레임워크를 넣지 않는다. 필요한 것은 케이스 목록과 단정 몇 개뿐이고,
 * 러너를 도입하면 CI 에서 또 하나의 실패 지점이 된다.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { JSDOM, VirtualConsole } from 'jsdom';

// 판정 규칙은 프로덕션과 같은 것을 쓴다. 테스트에 복사하면 규칙이 바뀔 때 어긋난다.
import { ARCHIVE_AGE_SUSPECT_DAYS, isAgeSuspect } from '../lib/signals/evergreen.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORT = path.join(ROOT, 'data', 'report.html');
const PUBLIC = path.join(ROOT, 'docs', 'index.html');
const LEADS = path.join(ROOT, 'data', 'leads.json');

/* ================================================================== *
 * 미니 러너
 * ================================================================== */

interface Failure {
  test: string;
  message: string;
}

const failures: Failure[] = [];
let currentTest = '';
let assertions = 0;
let passedTests = 0;

function assert(cond: unknown, message: string): void {
  assertions++;
  if (!cond) failures.push({ test: currentTest, message });
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  assertions++;
  if (actual !== expected) {
    failures.push({
      test: currentTest,
      message: `${label}: 기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)}`,
    });
  }
}

const tests: Array<[string, (env: Env) => Promise<void> | void]> = [];
function test(name: string, fn: (env: Env) => Promise<void> | void): void {
  tests.push([name, fn]);
}

/* ================================================================== *
 * 환경
 * ================================================================== */

interface Env {
  win: any;
  doc: any;
  /** 보이는 회사 카드 */
  visibleGroups(): any[];
  /** 보이는 공고 카드 */
  visibleLeads(): any[];
  allGroups(): any[];
  allLeads(): any[];
  /** 요소가 실제로 화면에 있는가. hidden 속성과 조상까지 본다. */
  shown(el: any): boolean;
  key(k: string, opts?: Record<string, boolean>): void;
  type(value: string): Promise<void>;
  click(el: any): void;
  hash(): string;
  countText(): string;
  byId(id: string): any;
  /** 디바운스(180ms)를 넘긴다. */
  settle(): Promise<void>;
}

let html = '';

/** 원본 데이터. 생성물이 이것과 어긋나지 않는지 대조하는 데 쓴다. */
interface LeadsFile {
  summary: { total: number; hot: number; warm: number };
  leads: Array<{
    board: string;
    company: string;
    jobUrl: string;
    grade: string;
    ageDays: number | null;
  }>;
}
let leads: LeadsFile | null = null;

/**
 * 생성물을 실제 DOM 에 올린다.
 *
 * @param hash 초기 해시(`#tab=infra&hot=1`). 상태 복원을 검증할 때 쓴다.
 * @param opts.seedStorage 스크립트 실행 전에 심을 연락 이력 JSON 문자열.
 *   jsdom 은 인스턴스 간 localStorage 를 공유하지 않으므로 "다음 방문"을 재현하려면
 *   파싱 전에 넣어 주어야 한다.
 */
async function makeEnv(hash = '', opts: { seedStorage?: string } = {}): Promise<Env> {
  // 스크립트 오류를 조용히 삼키면 테스트가 통과로 보인다. 전부 실패로 올린다.
  const vc = new VirtualConsole();
  vc.on('jsdomError', (err: unknown) => {
    failures.push({
      test: currentTest,
      message: `jsdom 스크립트 오류: ${(err as Error)?.message ?? String(err)}`,
    });
  });

  const dom = new JSDOM(html, {
    // 불투명 오리진에서는 localStorage 와 replaceState 가 던진다.
    url: 'https://local.test/report.html' + hash,
    runScripts: 'dangerously',
    virtualConsole: vc,
    beforeParse(w: any) {
      if (opts.seedStorage !== undefined) {
        w.localStorage.setItem('hiresignal.contacted.v1', opts.seedStorage);
      }
    },
  });

  const win = dom.window;
  const doc = win.document;

  const shown = (el: any): boolean => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hasAttribute('hidden')) return false;
    }
    return true;
  };

  const env: Env = {
    win,
    doc,
    shown,
    allGroups: () => Array.from(doc.querySelectorAll('.group-card')),
    allLeads: () => Array.from(doc.querySelectorAll('.card')),
    visibleGroups: () =>
      Array.from(doc.querySelectorAll('.group-card')).filter((el: any) => shown(el)),
    visibleLeads: () =>
      Array.from(doc.querySelectorAll('.card')).filter((el: any) => shown(el)),
    byId: (id: string) => doc.getElementById(id),
    click: (el: any) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true })),
    key: (k: string, opts: Record<string, boolean> = {}) => {
      doc.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));
    },
    type: async (value: string) => {
      const q = doc.getElementById('q');
      q.value = value;
      q.dispatchEvent(new win.Event('input', { bubbles: true }));
      await env.settle();
    },
    hash: () => win.location.hash,
    countText: () => doc.getElementById('count').textContent ?? '',
    settle: () => new Promise<void>((r) => win.setTimeout(r, 240)),
  };

  return env;
}

/* ================================================================== *
 * 테스트
 * ================================================================== */

test('초기 상태: 회사별 보기만 렌더된다', (env) => {
  // 이것이 `.feed { display:flex }` 가 [hidden] 을 덮던 결함의 회귀 테스트다.
  // 종전에는 공고 카드 457개가 회사 카드와 함께 화면에 있었다.
  assert(env.allGroups().length > 0, '회사 카드가 존재해야 한다');
  assert(env.allLeads().length > 0, '공고 카드가 존재해야 한다');
  assertEqual(env.visibleLeads().length, 0, '초기에는 공고 카드가 보이지 않아야 한다');
  assertEqual(
    env.visibleGroups().length,
    env.allGroups().length,
    '초기에는 회사 카드가 전부 보여야 한다',
  );
  assertEqual(env.byId('feed').hasAttribute('hidden'), true, '공고 피드는 hidden');
  assertEqual(env.byId('groups').hasAttribute('hidden'), false, '회사 피드는 표시');
});

test('보기 전환: 한쪽만 보인다', (env) => {
  const [company, lead] = Array.from(
    env.doc.querySelectorAll('.seg-btn[data-view]'),
  ) as any[];

  env.click(lead);
  assert(env.visibleLeads().length > 0, '공고별로 바꾸면 공고 카드가 보인다');
  assertEqual(env.visibleGroups().length, 0, '공고별에서 회사 카드는 숨는다');
  assertEqual(lead.getAttribute('aria-pressed'), 'true', '공고별 버튼이 눌린 상태');

  env.click(company);
  assertEqual(env.visibleLeads().length, 0, '회사별로 되돌리면 공고 카드가 숨는다');
  assert(env.visibleGroups().length > 0, '회사 카드가 다시 보인다');
});

test('검색: 디바운스 후 걸러지고 접힌 직무도 잡는다', async (env) => {
  const before = env.visibleGroups().length;
  await env.type('cresta');
  const after = env.visibleGroups();
  assert(after.length < before, '검색어로 줄어들어야 한다');
  assertEqual(after.length, 1, 'cresta 는 한 회사');
  assertEqual(after[0].getAttribute('data-company'), 'cresta', '맞는 회사가 남는다');

  // 접힌(hidden) 직무의 제목으로도 검색되어야 한다. 검색 blob 은 전체 직무를 담는다.
  const card = after[0];
  const extra = card.querySelector('.role-extra');
  assert(!!extra, 'cresta 는 접힌 직무가 있다');
  assertEqual(env.shown(extra), false, '접힌 직무는 보이지 않는다');

  await env.type('');
  assertEqual(env.visibleGroups().length, before, '검색어를 비우면 복구된다');
});

test('검색: 결과 없음 안내가 뜬다', async (env) => {
  await env.type('zzz-존재하지-않는-회사');
  assertEqual(env.visibleGroups().length, 0, '아무것도 남지 않는다');
  assertEqual(env.byId('empty').hasAttribute('hidden'), false, '안내가 보인다');
  await env.type('');
  assertEqual(env.byId('empty').hasAttribute('hidden'), true, '복구되면 안내가 사라진다');
});

test('Hot만 필터: hot 자리를 가진 회사만 남는다', (env) => {
  const hotBtn = env.byId('only-hot');
  const expected = env
    .allGroups()
    .filter((el: any) => Number(el.getAttribute('data-hot') || 0) > 0).length;

  assert(expected > 0, '테스트 데이터에 hot 회사가 있어야 한다');
  env.click(hotBtn);
  assertEqual(hotBtn.getAttribute('aria-pressed'), 'true', '버튼이 눌린 상태');
  assertEqual(env.visibleGroups().length, expected, 'hot 회사 수와 일치');

  env.click(hotBtn);
  assertEqual(env.visibleGroups().length, env.allGroups().length, '해제하면 복구');
});

test('필터 합성: 탭과 Hot 이 함께 적용된다', (env) => {
  const infraTab = Array.from(env.doc.querySelectorAll('.tab')).find(
    (t: any) => t.getAttribute('data-tab') === 'infra',
  ) as any;
  assert(!!infraTab, 'infra 탭이 있어야 한다');

  env.click(infraTab);
  const tabOnly = env.visibleGroups().length;

  env.click(env.byId('only-hot'));
  const both = env.visibleGroups();

  assert(both.length <= tabOnly, '필터를 겹치면 늘어나지 않는다');
  for (const el of both) {
    assert(
      (el.getAttribute('data-groups') || '').split(' ').includes('infra'),
      '남은 카드는 infra 를 포함해야 한다',
    );
    assert(Number(el.getAttribute('data-hot') || 0) > 0, '남은 카드는 hot 을 가져야 한다');
  }
});

test('연락 표시: localStorage 에 남고 미연락 필터에 반영된다', (env) => {
  const card = env.visibleGroups()[0];
  const key = card.getAttribute('data-key');
  const mark = card.querySelector('[data-mark]');

  assertEqual(mark.getAttribute('aria-pressed'), 'false', '처음에는 미표시');
  env.click(mark);
  assertEqual(mark.getAttribute('aria-pressed'), 'true', '누르면 표시됨');
  assertEqual(card.classList.contains('is-contacted'), true, '카드가 옅어진다');

  const stored = JSON.parse(env.win.localStorage.getItem('hiresignal.contacted.v1') || '{}');
  assert(!!stored[key], `localStorage 에 ${key} 가 저장된다`);
  assert(env.countText().includes('연락함 1곳'), `개수 표시에 반영: "${env.countText()}"`);

  // 표시해도 목록에서 사라지지는 않는다 (되돌릴 수 있어야 하므로)
  assertEqual(env.shown(card), true, '표시한 카드는 계속 보인다');

  // 미연락만 필터를 켜면 빠진다
  env.click(env.byId('only-todo'));
  assertEqual(env.shown(card), false, '미연락만 필터에서 제외된다');

  env.click(env.byId('only-todo'));
  env.click(mark);
  assertEqual(mark.getAttribute('aria-pressed'), 'false', '다시 누르면 해제');
  const after = JSON.parse(env.win.localStorage.getItem('hiresignal.contacted.v1') || '{}');
  assert(!after[key], '해제하면 저장에서도 지워진다');
});

test('연락 표시: 저장된 이력이 다음 방문에 복원된다', async (env) => {
  // 먼저 실제로 눌러서 저장 형식을 얻는다. 형식을 손으로 적으면 저장 로직이
  // 바뀌어도 테스트가 통과해 버린다.
  const card = env.visibleGroups()[0];
  const key = card.getAttribute('data-key');
  env.click(card.querySelector('[data-mark]'));
  const saved = env.win.localStorage.getItem('hiresignal.contacted.v1');
  assert(!!saved, '저장된 값이 있어야 한다');

  // jsdom 은 인스턴스 간 localStorage 를 공유하지 않으므로, 스크립트가 읽기 전에
  // beforeParse 로 심어 준다. "다음 방문"을 재현하는 유일한 방법이다.
  const next = await makeEnv('', { seedStorage: saved as string });
  try {
    const restored = next.doc.querySelector(`.group-card[data-key="${key}"]`);
    assert(!!restored, '같은 회사 카드를 찾는다');
    assertEqual(
      restored.querySelector('[data-mark]').getAttribute('aria-pressed'),
      'true',
      '새로 열어도 표시가 남아 있다',
    );
    assertEqual(restored.classList.contains('is-contacted'), true, '옅은 상태도 복원');
    assert(next.countText().includes('연락함 1곳'), `개수 표시에도 반영: "${next.countText()}"`);
  } finally {
    next.win.close();
  }
});

test('연락 표시: 경과일이 보이고 오래된 연락은 후속 대상으로 표시된다', async (env) => {
  // 회사 키를 먼저 얻는다. 특정 회사명을 박으면 데이터가 바뀐 날 실패한다.
  const [a, b, c] = env.visibleGroups().slice(0, 3) as any[];
  const iso = (daysAgo: number) =>
    new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10);

  const seed = JSON.stringify({
    [a.getAttribute('data-key')]: iso(0),
    [b.getAttribute('data-key')]: iso(5),
    [c.getAttribute('data-key')]: iso(45),
  });

  const next = await makeEnv('', { seedStorage: seed });
  try {
    const find = (el: any) =>
      next.doc.querySelector(`.group-card[data-key="${el.getAttribute('data-key')}"]`);

    const today = find(a);
    const recent = find(b);
    const old = find(c);

    assert(
      today.querySelector('[data-mark]').textContent.includes('오늘 연락'),
      `오늘: "${today.querySelector('[data-mark]').textContent.trim()}"`,
    );
    assert(
      recent.querySelector('[data-mark]').textContent.includes('5일 전 연락'),
      `5일 전: "${recent.querySelector('[data-mark]').textContent.trim()}"`,
    );
    assert(
      old.querySelector('[data-mark]').textContent.includes('45일 전 연락'),
      `45일 전: "${old.querySelector('[data-mark]').textContent.trim()}"`,
    );

    assertEqual(today.classList.contains('is-stale'), false, '오늘 연락은 후속 대상 아님');
    assertEqual(recent.classList.contains('is-stale'), false, '5일 전도 아님');
    assertEqual(old.classList.contains('is-stale'), true, '45일 전은 후속 대상');
    assert(
      (old.querySelector('[data-mark]').getAttribute('title') || '').includes('후속'),
      '후속 검토 사유를 title 로 알린다',
    );
    assertEqual(
      recent.querySelector('[data-mark]').getAttribute('title'),
      null,
      '최근 연락에는 title 을 붙이지 않는다',
    );

    // 필터 의미는 바뀌지 않아야 한다. 미연락만 = 한 번도 연락하지 않은 곳.
    next.click(next.byId('only-todo'));
    assertEqual(next.shown(old), false, '오래된 연락도 미연락만 필터에서는 제외된다');
  } finally {
    next.win.close();
  }
});

test('연락 표시: 날짜가 깨져 있어도 표시는 유지된다', async (env) => {
  // 손으로 붙여넣은 JSON 에 날짜가 아닌 값이 들어올 수 있다. 그때 라벨이 NaN 이
  // 되거나 던지면 안 된다.
  const key = env.visibleGroups()[0].getAttribute('data-key');
  const next = await makeEnv('', { seedStorage: JSON.stringify({ [key]: '날짜아님' }) });
  try {
    const card = next.doc.querySelector(`.group-card[data-key="${key}"]`);
    const btn = card.querySelector('[data-mark]');
    assertEqual(btn.getAttribute('aria-pressed'), 'true', '표시는 유지된다');
    assertEqual(card.classList.contains('is-contacted'), true, '옅은 상태도 유지');
    assertEqual(card.classList.contains('is-stale'), false, '후속 대상으로 오판하지 않는다');
    assert(!btn.textContent.includes('NaN'), `NaN 이 새지 않는다: "${btn.textContent.trim()}"`);
    assert(btn.textContent.includes('연락함'), '경과일 없이 기본 라벨로 떨어진다');
  } finally {
    next.win.close();
  }
});

test('연락 표시: 저장이 깨져 있어도 화면은 동작한다', async (env) => {
  // localStorage 에 남의 값이나 손상된 JSON 이 들어 있을 수 있다. 그때 스크립트가
  // 던지면 필터·정렬·초안까지 전부 죽는다.
  const broken = await makeEnv('', { seedStorage: '{이건 JSON 이 아니다' });
  try {
    assert(broken.visibleGroups().length > 0, '카드가 정상 렌더된다');
    broken.click(broken.byId('only-hot'));
    assertEqual(
      broken.byId('only-hot').getAttribute('aria-pressed'),
      'true',
      '필터도 정상 동작한다',
    );
  } finally {
    broken.win.close();
  }
});

test('보기 전환이 Hot·미연락 필터를 꺼뜨리지 않는다', (env) => {
  // 회귀 테스트. `segs` 가 .seg-btn 전체를 잡던 동안 setView 가 Hot만·미연락만
  // 버튼의 aria-pressed 까지 data-view 기준으로 덮어써서, 보기를 전환하면 두
  // 필터가 조용히 꺼졌다. 정적 검사로는 잡히지 않던 결함이다.
  const hot = env.byId('only-hot');
  const todo = env.byId('only-todo');

  env.click(hot);
  env.click(todo);
  assertEqual(hot.getAttribute('aria-pressed'), 'true', '전환 전 Hot 켜짐');
  assertEqual(todo.getAttribute('aria-pressed'), 'true', '전환 전 미연락 켜짐');

  env.click(env.doc.querySelector('.seg-btn[data-view="lead"]'));
  assertEqual(hot.getAttribute('aria-pressed'), 'true', '공고별로 바꿔도 Hot 유지');
  assertEqual(todo.getAttribute('aria-pressed'), 'true', '공고별로 바꿔도 미연락 유지');

  env.click(env.doc.querySelector('.seg-btn[data-view="company"]'));
  assertEqual(hot.getAttribute('aria-pressed'), 'true', '회사별로 돌아와도 Hot 유지');
  assertEqual(todo.getAttribute('aria-pressed'), 'true', '회사별로 돌아와도 미연락 유지');

  // 해시에도 남아 있어야 한다
  assert(env.hash().includes('hot=1'), `해시에 hot 유지: ${env.hash()}`);
  assert(env.hash().includes('todo=1'), `해시에 todo 유지: ${env.hash()}`);

  // 그리고 실제로 필터가 걸려 있어야 한다 (aria 만 맞고 화면이 다르면 무의미)
  for (const el of env.visibleGroups()) {
    assert(Number(el.getAttribute('data-hot') || 0) > 0, '남은 카드는 hot 을 가진다');
  }
});

test('연락 표시가 공고별 보기에도 반영된다', (env) => {
  const card = env.visibleGroups()[0];
  const key = card.getAttribute('data-key');
  env.click(card.querySelector('[data-mark]'));

  env.click(env.doc.querySelector('.seg-btn[data-view="lead"]'));
  const leads = (env.allLeads() as any[]).filter(
    (el) => el.getAttribute('data-key') === key,
  );
  assert(leads.length > 0, '같은 회사의 공고 카드가 있다');
  for (const el of leads) {
    assertEqual(
      el.classList.contains('is-contacted'),
      true,
      '공고 카드도 연락 상태를 보여준다',
    );
    // 회사 단위 결정을 공고에서 뒤집을 수 있으면 어느 쪽이 참인지 알 수 없다.
    assertEqual(el.querySelector('[data-mark]'), null, '공고 카드에는 표시 버튼이 없다');
  }
});

test('필터 초기화: 필터가 걸릴 때만 보이고 전부 되돌린다', async (env) => {
  const reset = env.byId('reset-btn');
  assertEqual(reset.hasAttribute('hidden'), true, '기본 상태에서는 숨어 있다');

  const infraTab = (Array.from(env.doc.querySelectorAll('.tab')) as any[]).find(
    (t) => t.getAttribute('data-tab') === 'infra',
  );
  env.click(infraTab);
  env.click(env.byId('only-hot'));
  await env.type('engineer');
  assertEqual(reset.hasAttribute('hidden'), false, '필터가 걸리면 나타난다');

  env.click(reset);
  assertEqual(env.byId('q').value, '', '검색어가 비워진다');
  assertEqual(env.byId('only-hot').getAttribute('aria-pressed'), 'false', 'Hot 해제');
  assertEqual(
    env.doc.querySelector('.tab[data-tab="all"]').getAttribute('aria-pressed'),
    'true',
    '전체 탭으로 돌아온다',
  );
  assertEqual(env.visibleGroups().length, env.allGroups().length, '전부 다시 보인다');
  assertEqual(env.hash(), '', '해시도 비워진다');
  assertEqual(reset.hasAttribute('hidden'), true, '다시 숨는다');

  // 정렬은 결과 집합을 바꾸지 않으므로 초기화 대상이 아니다
  env.byId('sort').value = 'age';
  env.byId('sort').dispatchEvent(new env.win.Event('change', { bubbles: true }));
  assertEqual(reset.hasAttribute('hidden'), true, '정렬만으로는 초기화 버튼이 안 뜬다');
});

test('빈 상태에서도 초기화할 수 있다', async (env) => {
  await env.type('zzz-없는-회사');
  assertEqual(env.byId('empty').hasAttribute('hidden'), false, '빈 상태 안내가 보인다');
  env.click(env.byId('empty-reset'));
  assertEqual(env.byId('empty').hasAttribute('hidden'), true, '안내가 사라진다');
  assertEqual(env.visibleGroups().length, env.allGroups().length, '전부 복구된다');
});

test('검색: 화면에 보이는 보드 문자열로 찾을 수 있다', async (env) => {
  // 카드에 `greenhouse:cresta` 같은 보드가 보이는데 그걸로 검색이 안 되면
  // 화면과 검색이 어긋난 것이다.
  //
  // 특정 회사명을 박아 두지 않는다. 리드는 매일 바뀌므로 어제 있던 회사가 오늘
  // 없을 수 있고, 그러면 테스트가 제품이 아니라 그날의 데이터를 판정하게 된다.
  // 실제로 smartrecruiters 를 박아 뒀다가 그 보드가 리드에서 빠진 날 실패했다.
  const sample = env.visibleGroups()[0];
  const board = sample.querySelector('.meta').textContent.split('·')[0].trim();
  assert(/^[a-z]+:[a-z0-9-]+$/.test(board), `보드 문자열 형식 확인: "${board}"`);

  await env.type(board);
  const found = env.visibleGroups();
  assertEqual(found.length, 1, `보드 전체(${board})로는 한 곳만 남는다`);
  assertEqual(
    found[0].getAttribute('data-company'),
    sample.getAttribute('data-company'),
    '맞는 회사가 남는다',
  );

  // ATS 접두사만으로도 걸려야 한다. 기대 개수를 데이터에서 센다.
  const ats = board.split(':')[0] as string;
  const expected = (env.allGroups() as any[]).filter((el) =>
    el.querySelector('.meta').textContent.trim().startsWith(ats + ':'),
  ).length;
  assert(expected > 0, `${ats} 보드가 존재한다 (${expected}곳)`);

  await env.type(ats);
  assertEqual(env.visibleGroups().length, expected, `ATS 접두사(${ats})로 ${expected}곳`);
});

test('연락 결과: 연락하지 않으면 기록할 수 없다', (env) => {
  // 보내지도 않은 건의 "무응답"은 데이터가 아니라 노이즈다. 응답률을 조용히 왜곡한다.
  const card = env.visibleGroups()[0];
  assertEqual(
    card.querySelector('.outcome').hasAttribute('hidden'),
    true,
    '연락 전에는 결과 버튼이 숨어 있다',
  );

  env.key('j');
  env.key('x'); // 결과 기록 시도
  assertEqual(
    env.win.localStorage.getItem('hiresignal.outcomes.v1'),
    null,
    '저장이 생기지 않는다',
  );
});

test('연락 결과: 기록되고 경과일·스택이 함께 남는다', (env) => {
  const card = env.visibleGroups()[0];
  const key = card.getAttribute('data-key');

  env.key('j');
  env.key('m'); // 연락함
  assertEqual(
    card.querySelector('.outcome').hasAttribute('hidden'),
    false,
    '연락하면 결과 버튼이 나타난다',
  );

  env.key('a'); // 답신
  const stored = JSON.parse(env.win.localStorage.getItem('hiresignal.outcomes.v1') || '{}');
  assert(!!stored[key], '결과가 저장된다');
  assertEqual(stored[key].result, 'reply', '누른 결과가 기록된다');

  // 나중에 "어느 구간이 응답하는가"를 세려면 그때의 리드 속성이 필요하다.
  // 리드는 매일 바뀌므로 사후 조회가 불가능하다.
  assertEqual(
    stored[key].ageDays,
    Number(card.getAttribute('data-age')),
    '경과일이 함께 남는다',
  );
  assertEqual(typeof stored[key].tags, 'string', '스택이 함께 남는다');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(stored[key].at), `기록일이 남는다: ${stored[key].at}`);

  const pressed = card.querySelector('[data-outcome="reply"]');
  assertEqual(pressed.getAttribute('aria-pressed'), 'true', '버튼 상태가 반영된다');
  assertEqual(card.classList.contains('has-outcome'), true, '처리 완료로 표시된다');

  // 같은 값을 다시 누르면 해제
  env.key('a');
  assertEqual(
    Object.keys(JSON.parse(env.win.localStorage.getItem('hiresignal.outcomes.v1') || '{}')).length,
    0,
    '같은 결과를 다시 누르면 해제된다',
  );
});

test('연락 결과: 하나만 선택된다', (env) => {
  const card = env.visibleGroups()[0];
  env.key('j');
  env.key('m');

  env.key('x'); // 무응답
  env.key('r'); // 거절로 변경
  const pressedAll = (Array.from(card.querySelectorAll('[data-outcome]')) as any[]).filter(
    (b) => b.getAttribute('aria-pressed') === 'true',
  );
  assertEqual(pressedAll.length, 1, '동시에 하나만 눌린 상태');
  assertEqual(pressedAll[0].getAttribute('data-outcome'), 'reject', '마지막 선택이 남는다');
});

test('연락 결과: 연락 표시를 지우면 결과도 지워진다', (env) => {
  const card = env.visibleGroups()[0];
  const key = card.getAttribute('data-key');
  env.key('j');
  env.key('m');
  env.key('w'); // 수주
  assert(
    !!JSON.parse(env.win.localStorage.getItem('hiresignal.outcomes.v1') || '{}')[key],
    '결과가 있다',
  );

  env.key('m'); // 연락 표시 해제
  // 근거 없는 결과가 통계에 남으면 응답률이 조용히 왜곡된다.
  assert(
    !JSON.parse(env.win.localStorage.getItem('hiresignal.outcomes.v1') || '{}')[key],
    '연락 표시를 지우면 결과도 사라진다',
  );
  assertEqual(
    card.querySelector('.outcome').hasAttribute('hidden'),
    true,
    '결과 버튼도 다시 숨는다',
  );
});

test('연락 결과: 결과가 기록되면 후속 대상에서 빠진다', async (env) => {
  // 거절을 받았는데 30일 뒤에 "후속 연락을 검토하세요"라고 권하면 안 된다.
  const key = env.visibleGroups()[0].getAttribute('data-key');
  const old = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);

  const seeded = await makeEnv('', { seedStorage: JSON.stringify({ [key]: old }) });
  try {
    const card = seeded.doc.querySelector(`.group-card[data-key="${key}"]`);
    assertEqual(card.classList.contains('is-stale'), true, '결과 없으면 후속 대상');

    seeded.click(card.querySelector('[data-outcome="reject"]'));
    assertEqual(card.classList.contains('is-stale'), false, '거절을 기록하면 후속 대상에서 빠진다');
  } finally {
    seeded.win.close();
  }
});

test('응답률 표: 경과일 구간별로 집계된다', (env) => {
  const panel = env.byId('outcome-table');
  assert(!!panel, '응답률 표 영역이 있다');
  assert(
    panel.textContent.includes('결과를 기록하면'),
    '기록이 없으면 안내를 보여준다',
  );

  // 서로 다른 경과일 구간의 카드 두 개를 골라 기록한다
  const cards = env.visibleGroups() as any[];
  const younger = cards.find((c) => Number(c.getAttribute('data-age')) < 365);
  const older = cards.find((c) => Number(c.getAttribute('data-age')) >= 365);
  assert(!!younger && !!older, '두 구간의 카드가 존재한다');

  for (const [card, outcome] of [
    [younger, 'reply'],
    [older, 'none'],
  ] as Array<[any, string]>) {
    env.click(card.querySelector('[data-mark]'));
    env.click(card.querySelector(`[data-outcome="${outcome}"]`));
  }

  const text = env.byId('outcome-table').textContent;
  assert(text.includes('/'), `구간별 비율이 나온다: ${text.slice(0, 120)}`);
  assert(text.includes('답신 1'), `결과 종류별 합계가 나온다: ${text.slice(0, 200)}`);
  assert(text.includes('무응답 1'), '무응답도 집계된다');
  assert(
    env.byId('outcome-summary').textContent.includes('결과 기록 2건'),
    `요약에 기록 수가 나온다: ${env.byId('outcome-summary').textContent}`,
  );
});

test('연락 이력 백업: 담기와 적용이 동작한다', (env) => {
  const cards = env.visibleGroups().slice(0, 2);
  const keys = cards.map((c: any) => c.getAttribute('data-key'));
  cards.forEach((c: any) => env.click(c.querySelector('[data-mark]')));

  env.key('?'); // 도움말 열기
  env.click(env.byId('io-dump'));
  const dumped = env.byId('io').value;
  const parsed = JSON.parse(dumped);
  assertEqual(Object.keys(parsed).length, 2, '담긴 이력이 2곳');
  for (const k of keys) assert(!!parsed[k], `${k} 가 담긴다`);
  assert(env.byId('io-msg').textContent.includes('2곳'), '담은 개수를 알린다');

  // 전부 해제한 뒤 다시 적용하면 복구되어야 한다
  cards.forEach((c: any) => env.click(c.querySelector('[data-mark]')));
  assertEqual(
    Object.keys(JSON.parse(env.win.localStorage.getItem('hiresignal.contacted.v1') || '{}')).length,
    0,
    '해제되어 비었다',
  );

  env.byId('io').value = dumped;
  env.click(env.byId('io-apply'));
  for (const c of cards) {
    assertEqual(
      c.querySelector('[data-mark]').getAttribute('aria-pressed'),
      'true',
      '적용으로 복구된다',
    );
  }
  assert(env.byId('io-msg').textContent.includes('2곳을 추가'), '추가 개수를 알린다');
});

test('연락 이력 백업: 잘못된 입력을 안전하게 거부한다', (env) => {
  env.key('?');
  const msg = env.byId('io-msg');

  env.byId('io').value = '';
  env.click(env.byId('io-apply'));
  assertEqual(msg.getAttribute('data-tone'), 'bad', '빈 입력은 거부');

  env.byId('io').value = '{이건 JSON 이 아니다';
  env.click(env.byId('io-apply'));
  assertEqual(msg.getAttribute('data-tone'), 'bad', '깨진 JSON 은 거부');
  assert(msg.textContent.includes('JSON'), `사유를 알린다: ${msg.textContent}`);

  env.byId('io').value = '["배열은 안 된다"]';
  env.click(env.byId('io-apply'));
  assertEqual(msg.getAttribute('data-tone'), 'bad', '배열은 거부');

  // 거부 후에도 화면이 살아 있어야 한다
  env.click(env.byId('only-hot'));
  assertEqual(env.byId('only-hot').getAttribute('aria-pressed'), 'true', '필터는 여전히 동작');
});

test('연락 이력 백업: 가져오기가 기존 표시를 지우지 않는다', (env) => {
  const [a, b] = env.visibleGroups().slice(0, 2) as any[];
  const keyA = a.getAttribute('data-key');
  const keyB = b.getAttribute('data-key');

  env.click(a.querySelector('[data-mark]')); // A 만 표시
  env.key('?');
  env.byId('io').value = JSON.stringify({ [keyB]: '2026-01-01' });
  env.click(env.byId('io-apply'));

  assertEqual(
    a.querySelector('[data-mark]').getAttribute('aria-pressed'),
    'true',
    'A 는 그대로 남는다 (덮어쓰기 아님)',
  );
  assertEqual(
    b.querySelector('[data-mark]').getAttribute('aria-pressed'),
    'true',
    'B 가 추가된다',
  );
});

test('연락 이력 백업: 목록에 없는 키는 건너뛴다', (env) => {
  env.key('?');
  env.byId('io').value = JSON.stringify({
    'greenhouse:존재하지않는회사': '2026-01-01',
    'lever:이것도없음': '2026-01-01',
  });
  env.click(env.byId('io-apply'));
  const msg = env.byId('io-msg').textContent;
  assert(msg.includes('0곳을 추가'), `추가 0곳: ${msg}`);
  assert(msg.includes('2곳은 건너뜁니다'), `건너뛴 수를 알린다: ${msg}`);
  assertEqual(
    Object.keys(JSON.parse(env.win.localStorage.getItem('hiresignal.contacted.v1') || '{}')).length,
    0,
    '저장에 쓰레기가 남지 않는다',
  );
});

test('더 보기: 접힌 직무가 열리고 다시 닫힌다', (env) => {
  const card = env
    .allGroups()
    .find((el: any) => el.querySelector('[data-more]')) as any;
  assert(!!card, '접힌 직무가 있는 카드가 존재해야 한다');

  const btn = card.querySelector('[data-more]');
  const extras = Array.from(card.querySelectorAll('.role-extra')) as any[];
  const visibleBefore = Array.from(card.querySelectorAll('li')).filter((li: any) =>
    env.shown(li),
  ).length;

  assertEqual(visibleBefore, 3, '접힌 상태에서는 직무 3개만 보인다');
  assert(extras.length > 0, '접힌 직무가 있다');
  assertEqual(btn.getAttribute('aria-expanded'), 'false', '초기 aria-expanded=false');

  env.click(btn);
  assertEqual(btn.getAttribute('aria-expanded'), 'true', '열면 true');
  assertEqual(
    extras.every((li) => env.shown(li)),
    true,
    '접혔던 직무가 전부 보인다',
  );
  assertEqual(btn.textContent.trim(), '접기', '라벨이 바뀐다');

  env.click(btn);
  assertEqual(btn.getAttribute('aria-expanded'), 'false', '다시 닫으면 false');
  assertEqual(extras.some((li) => env.shown(li)), false, '다시 숨는다');
  assert(btn.textContent.includes('더 보기'), '라벨이 되돌아온다');

  // aria-controls 가 실제 목록을 가리켜야 한다
  const controlled = env.doc.getElementById(btn.getAttribute('aria-controls'));
  assert(!!controlled && controlled.classList.contains('role-list'), 'aria-controls 대상이 맞다');
});

test('URL 해시: 상태가 기록되고 복원된다', async (env) => {
  const infraTab = Array.from(env.doc.querySelectorAll('.tab')).find(
    (t: any) => t.getAttribute('data-tab') === 'infra',
  ) as any;

  env.click(infraTab);
  env.click(env.byId('only-hot'));
  await env.type('engineer');
  env.byId('sort').value = 'age';
  env.byId('sort').dispatchEvent(new env.win.Event('change', { bubbles: true }));

  const h = env.hash();
  assert(h.includes('tab=infra'), `해시에 탭: ${h}`);
  assert(h.includes('hot=1'), `해시에 hot: ${h}`);
  assert(h.includes('q=engineer'), `해시에 검색어: ${h}`);
  assert(h.includes('sort=age'), `해시에 정렬(셀렉트 경로): ${h}`);

  const expected = env.visibleGroups().length;

  // 같은 해시를 주고 새로 열면 같은 화면이 나와야 한다. 이것이 "북마크가 동작한다"는
  // 주장의 실제 내용이다.
  const restored = await makeEnv(h);
  try {
    assertEqual(restored.byId('sort').value, 'age', '정렬이 복원된다');
    assertEqual(restored.byId('only-hot').getAttribute('aria-pressed'), 'true', 'hot 복원');
    assertEqual(restored.byId('q').value, 'engineer', '검색어 복원');

    const pressed = (Array.from(restored.doc.querySelectorAll('.tab')) as any[]).find(
      (t) => t.getAttribute('aria-pressed') === 'true',
    );
    assertEqual(pressed?.getAttribute('data-tab'), 'infra', '탭 복원');
    assertEqual(restored.visibleGroups().length, expected, '복원된 화면의 카드 수가 같다');
  } finally {
    restored.win.close();
  }
});

test('URL 해시: 기본 상태에서는 비어 있다', (env) => {
  assertEqual(env.hash(), '', '기본 상태는 해시를 남기지 않는다');
});

test('정렬: 오래된 순이 실제로 재배치한다', (env) => {
  const sort = env.byId('sort');
  sort.value = 'age';
  sort.dispatchEvent(new env.win.Event('change', { bubbles: true }));

  const ages = env
    .visibleGroups()
    .map((el: any) => Number(el.getAttribute('data-age') || 0));
  const sorted = [...ages].sort((a, b) => b - a);
  assertEqual(JSON.stringify(ages), JSON.stringify(sorted), '경과일 내림차순');

  sort.value = 'company';
  sort.dispatchEvent(new env.win.Event('change', { bubbles: true }));
  const names = env.visibleGroups().map((el: any) => el.getAttribute('data-company'));
  assertEqual(
    JSON.stringify(names),
    JSON.stringify([...names].sort((a, b) => String(a).localeCompare(String(b)))),
    '회사명 오름차순',
  );
});

test('정렬: 자리 많은 순은 공고별에서 비활성', (env) => {
  const countOpt = env.byId('sort').querySelector('option[value="count"]');
  assertEqual(countOpt.disabled, false, '회사별에서는 활성');

  const leadBtn = env.doc.querySelector('.seg-btn[data-view="lead"]');
  env.click(leadBtn);
  assertEqual(countOpt.disabled, true, '공고별에서는 비활성');

  // 비활성 항목이 선택된 상태로 전환되면 기본으로 되돌아야 한다
  const companyBtn = env.doc.querySelector('.seg-btn[data-view="company"]');
  env.click(companyBtn);
  env.byId('sort').value = 'count';
  env.byId('sort').dispatchEvent(new env.win.Event('change', { bubbles: true }));
  env.click(leadBtn);
  assertEqual(env.byId('sort').value, 'default', '비활성 정렬은 기본으로 되돌린다');
});

test('단축키: / 로 검색 이동, Esc 로 비우기', async (env) => {
  env.key('/');
  assertEqual(env.doc.activeElement.id, 'q', '/ 는 검색으로 포커스를 옮긴다');

  await env.type('cresta');
  assertEqual(env.visibleGroups().length, 1, '검색이 적용된 상태');

  env.key('Escape');
  assertEqual(env.byId('q').value, '', 'Esc 가 검색어를 비운다');
  assert(env.visibleGroups().length > 1, '필터가 즉시 풀린다');
});

test('단축키: 입력 중에는 문자 단축키가 무시된다', async (env) => {
  const q = env.byId('q');
  q.focus();
  assertEqual(env.doc.activeElement.id, 'q', '검색에 포커스');

  const before = env.byId('only-hot').getAttribute('aria-pressed');
  // 검색창에 h 를 타이핑하는 상황. Hot 필터가 켜지면 안 된다.
  q.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'h', bubbles: true }));
  assertEqual(
    env.byId('only-hot').getAttribute('aria-pressed'),
    before,
    '입력 중 h 는 Hot 필터를 건드리지 않는다',
  );
});

test('단축키: v / h / u / s / 숫자', (env) => {
  env.key('v');
  assert(env.visibleLeads().length > 0, 'v 가 공고별로 전환');
  env.key('v');
  assert(env.visibleGroups().length > 0, 'v 가 회사별로 복귀');

  env.key('h');
  assertEqual(env.byId('only-hot').getAttribute('aria-pressed'), 'true', 'h 가 Hot 토글');
  env.key('h');
  assertEqual(env.byId('only-hot').getAttribute('aria-pressed'), 'false', 'h 가 해제');

  env.key('u');
  assertEqual(env.byId('only-todo').getAttribute('aria-pressed'), 'true', 'u 가 미연락 토글');
  env.key('u');

  const before = env.byId('sort').value;
  env.key('s');
  assert(env.byId('sort').value !== before, 's 가 정렬을 바꾼다');
  assert(env.hash().includes('sort='), 's 로 바꾼 정렬도 해시에 남는다');

  const tabs = Array.from(env.doc.querySelectorAll('.tab')) as any[];
  env.key('1');
  assertEqual(tabs[1].getAttribute('aria-pressed'), 'true', '1 이 첫 직군 탭');
  env.key('0');
  assertEqual(tabs[0].getAttribute('aria-pressed'), 'true', '0 이 전체 탭');
});

test('카드 이동: 화면에 보이는 순서대로 옮겨간다', (env) => {
  // visibleGroups() 는 DOM 순서를 돌려준다. 이동도 같은 순서여야 한다 -
  // 실제로 원래 배열 순서를 쓰던 동안 j 가 정렬된 화면에서 엉뚱한 카드로 튀었다.
  const list = env.visibleGroups();
  assert(list.length > 2, '카드가 셋 이상 있어야 한다');

  // 기본 정렬은 신호순이다. DOM 순서가 실제로 그렇게 정렬돼 있는지 먼저 확인한다.
  const rels = list.map((el: any) => Number(el.getAttribute('data-rel')));
  assertEqual(
    JSON.stringify(rels),
    JSON.stringify([...rels].sort((a, b) => b - a)),
    'DOM 이 신호순으로 정렬돼 있다',
  );

  env.key('j');
  assertEqual(list[0].classList.contains('is-focused'), true, 'j 가 첫 카드를 고른다');
  assertEqual(env.doc.activeElement, list[0], '실제 DOM 포커스가 옮겨간다');

  env.key('j');
  assertEqual(list[1].classList.contains('is-focused'), true, '다음 카드로 이동');
  assertEqual(list[0].classList.contains('is-focused'), false, '이전 선택이 해제된다');

  env.key('k');
  assertEqual(list[0].classList.contains('is-focused'), true, 'k 가 되돌린다');

  // 경계에서 넘어가지 않는다
  env.key('k');
  env.key('k');
  assertEqual(list[0].classList.contains('is-focused'), true, '첫 카드에서 더 위로 안 간다');

  // 정렬을 바꾼 뒤에도 "다음 카드"는 화면상 바로 아래여야 한다.
  // 선택은 정렬 후에도 유지된다(자리를 잃지 않는 것이 옳다) - 그래서 절대 위치가
  // 아니라 "이동 결과가 DOM 상 다음 형제인가"를 본다.
  env.byId('sort').value = 'age';
  env.byId('sort').dispatchEvent(new env.win.Event('change', { bubbles: true }));

  const reordered = env.visibleGroups();
  assert(
    reordered[0].getAttribute('data-company') !== list[0].getAttribute('data-company'),
    '정렬로 첫 카드가 바뀌었다 (테스트 전제)',
  );

  const current = env.doc.querySelector('.is-focused');
  assert(!!current, '정렬 후에도 선택이 유지된다');
  const at = reordered.indexOf(current);
  assert(at !== -1, '선택된 카드가 화면 목록에 있다');

  env.key('j');
  assertEqual(
    reordered[at + 1]?.classList.contains('is-focused'),
    true,
    '정렬 후에도 화면상 바로 다음 카드로 이동한다',
  );
});

test('카드 이동: 선택한 카드가 필터로 사라지면 선택이 풀린다', async (env) => {
  env.key('j');
  const first = env.visibleGroups()[0];
  assertEqual(first.classList.contains('is-focused'), true, '선택된 상태');

  await env.type('zzz-없는-회사');
  assertEqual(first.classList.contains('is-focused'), false, '사라진 카드의 선택이 풀린다');

  // 선택이 없는 상태에서 d 를 눌러도 아무 초안이 열리지 않아야 한다
  env.key('d');
  const opened = (Array.from(env.doc.querySelectorAll('.draft')) as any[]).filter(
    (el) => !el.hasAttribute('hidden'),
  );
  assertEqual(opened.length, 0, '보이지 않는 카드의 초안이 열리지 않는다');
});

test('카드 이동: m 으로 연락 표시', (env) => {
  env.key('j');
  const card = env.visibleGroups()[0];

  env.key('m');
  assertEqual(
    card.querySelector('[data-mark]').getAttribute('aria-pressed'),
    'true',
    'm 이 연락 표시를 켠다',
  );
  env.key('m');
  assertEqual(
    card.querySelector('[data-mark]').getAttribute('aria-pressed'),
    'false',
    'm 이 다시 끈다',
  );
});

test('키보드 루프: d 로 열고 Esc 로 나와 다음 카드로 넘어간다', (env) => {
  // 하루 루프 전체를 키보드로 돈다. 초안을 열면 편집을 위해 포커스가 textarea 로
  // 가는데, 그 상태에서는 문자 단축키가 글자로 들어간다. Esc 가 없으면 초안을
  // 닫지도, 다음 카드로 넘어가지도 못한다 - 실제로 그 막힘이 있었다.
  env.key('j');
  const first = env.visibleGroups()[0];

  env.key('d');
  const box = first.querySelector('.draft');
  assertEqual(box.hasAttribute('hidden'), false, 'd 가 초안을 연다');
  assertEqual(
    env.doc.activeElement.tagName,
    'TEXTAREA',
    '편집할 수 있도록 포커스가 초안으로 간다',
  );
  assert(
    first.querySelector('textarea').value.includes(first.getAttribute('data-company')),
    '초안 내용이 채워진다',
  );

  // 초안 안에서는 문자 단축키가 동작하지 않아야 한다 (글자로 들어가야 정상)
  const hotBefore = env.byId('only-hot').getAttribute('aria-pressed');
  env.doc.activeElement.dispatchEvent(
    new env.win.KeyboardEvent('keydown', { key: 'h', bubbles: true }),
  );
  assertEqual(
    env.byId('only-hot').getAttribute('aria-pressed'),
    hotBefore,
    '초안 안에서 h 는 필터를 건드리지 않는다',
  );

  // Esc 가 탈출구다
  env.doc.activeElement.dispatchEvent(
    new env.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  assertEqual(box.hasAttribute('hidden'), true, 'Esc 가 초안을 닫는다');
  assertEqual(first.classList.contains('is-drafting'), false, '전체 폭 모드도 해제');
  assertEqual(env.doc.activeElement, first, '포커스가 카드로 돌아온다');

  // 그리고 루프가 계속된다
  env.key('j');
  assertEqual(
    env.visibleGroups()[1].classList.contains('is-focused'),
    true,
    '다음 카드로 넘어간다',
  );
  env.key('d');
  assertEqual(
    env.visibleGroups()[1].querySelector('.draft').hasAttribute('hidden'),
    false,
    '다음 카드의 초안도 열린다',
  );
});

test('키보드 루프: 공고별 보기에서도 같고 m 은 무해하다', (env) => {
  env.click(env.doc.querySelector('.seg-btn[data-view="lead"]'));
  env.key('j');
  const card = env.visibleLeads()[0];
  assertEqual(card.classList.contains('is-focused'), true, '공고 카드도 선택된다');

  env.key('d');
  assertEqual(card.querySelector('.draft').hasAttribute('hidden'), false, '초안이 열린다');
  env.doc.activeElement.dispatchEvent(
    new env.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  assertEqual(card.querySelector('.draft').hasAttribute('hidden'), true, 'Esc 로 닫힌다');

  // 공고 카드에는 연락 버튼이 없다. m 이 던지면 이후 키입력이 전부 죽는다.
  env.key('m');
  env.key('j');
  assertEqual(
    env.visibleLeads()[1].classList.contains('is-focused'),
    true,
    'm 이후에도 이동이 계속 동작한다',
  );
});

test('카드 이동: 입력 중에는 j/k 가 글자로 들어간다', (env) => {
  const input = env.byId('q');
  input.focus();
  input.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'j', bubbles: true }));
  const anyFocused = env.doc.querySelector('.is-focused');
  assertEqual(anyFocused, null, '검색 중 j 는 카드를 고르지 않는다');
});

test('단축키: 수정키가 눌린 조합은 무시된다', (env) => {
  const before = env.byId('only-hot').getAttribute('aria-pressed');
  env.key('h', { ctrlKey: true });
  env.key('h', { metaKey: true });
  assertEqual(
    env.byId('only-hot').getAttribute('aria-pressed'),
    before,
    'Ctrl/Cmd 조합은 브라우저 단축키이므로 가로채지 않는다',
  );
});

test('도움말: ? 로 열리고 Esc 로 닫힌다', (env) => {
  const help = env.byId('help');
  const btn = env.byId('help-btn');

  assertEqual(help.hasAttribute('hidden'), true, '처음에는 닫혀 있다');
  env.key('?');
  assertEqual(help.hasAttribute('hidden'), false, '? 로 열린다');
  assertEqual(btn.getAttribute('aria-expanded'), 'true', 'aria-expanded 동기화');

  env.key('Escape');
  assertEqual(help.hasAttribute('hidden'), true, 'Esc 로 닫힌다');
  assertEqual(btn.getAttribute('aria-expanded'), 'false', 'aria-expanded 복귀');

  env.click(btn);
  assertEqual(help.hasAttribute('hidden'), false, '버튼으로도 열린다');
  env.click(btn);
  assertEqual(help.hasAttribute('hidden'), true, '버튼으로 닫힌다');
});

test('초안: 생성되고 카드가 전체 폭을 쓴다', (env) => {
  const card = env.visibleGroups()[0];
  const btn = card.querySelector('[data-gdraft]');
  const box = env.doc.getElementById('gdraft-' + btn.getAttribute('data-gdraft'));
  const ta = env.doc.getElementById('gdraft-text-' + btn.getAttribute('data-gdraft'));

  assertEqual(box.hasAttribute('hidden'), true, '처음에는 닫혀 있다');
  env.click(btn);
  assertEqual(box.hasAttribute('hidden'), false, '열린다');
  assertEqual(card.classList.contains('is-drafting'), true, '카드가 전체 폭 모드로');

  const text = ta.value;
  assert(text.length > 200, `초안이 생성된다 (${text.length}자)`);
  assert(text.startsWith('Subject:'), '제목 줄로 시작');
  assert(text.includes(card.getAttribute('data-company')), '회사명이 들어간다');
  assert(!text.includes('undefined'), '미정의 값이 새지 않는다');
  assert(!text.includes('NaN'), 'NaN 이 새지 않는다');

  // 직무 목록이 초안에 반영되는가
  const roles = JSON.parse(card.getAttribute('data-roles'));
  assert(text.includes(String(roles[0])), '첫 직무가 초안에 들어간다');

  env.click(btn);
  assertEqual(box.hasAttribute('hidden'), true, '다시 닫힌다');
  assertEqual(card.classList.contains('is-drafting'), false, '전체 폭 모드 해제');
});

test('초안: 자리 수가 직무 수보다 많으면 그 사실을 밝힌다', (env) => {
  const card = env
    .allGroups()
    .find(
      (el: any) =>
        Number(el.getAttribute('data-seats')) > Number(el.getAttribute('data-rolecount')),
    ) as any;
  assert(!!card, '접힌 회사가 있어야 한다');

  const btn = card.querySelector('[data-gdraft]');
  env.click(btn);
  const ta = env.doc.getElementById('gdraft-text-' + btn.getAttribute('data-gdraft'));
  assert(
    ta.value.includes('separate postings'),
    `자리 수를 밝혀야 한다: ${ta.value.slice(0, 240)}`,
  );
});

test('공고별 카드: 초안과 링크가 동작한다', (env) => {
  env.click(env.doc.querySelector('.seg-btn[data-view="lead"]'));
  const card = env.visibleLeads()[0];
  const btn = card.querySelector('[data-draft]');
  env.click(btn);
  const ta = env.doc.getElementById('draft-text-' + btn.getAttribute('data-draft'));
  assert(ta.value.includes(card.getAttribute('data-company')), '회사명이 들어간다');
  assert(ta.value.includes(card.getAttribute('data-title')), '공고 제목이 들어간다');
  assertEqual(card.classList.contains('is-drafting'), true, '전체 폭 모드');
});

test('모든 외부 링크가 안전 속성을 갖는다', (env) => {
  const links = Array.from(env.doc.querySelectorAll('a[target="_blank"]')) as any[];
  assert(links.length > 400, `외부 링크가 많이 있어야 한다 (${links.length})`);
  const unsafe = links.filter((a) => {
    const rel = a.getAttribute('rel') || '';
    return !rel.includes('noopener') || !rel.includes('noreferrer');
  });
  assertEqual(unsafe.length, 0, `rel 누락 링크 ${unsafe.length}건`);

  const badScheme = links.filter((a) => !/^https?:/.test(a.getAttribute('href') || ''));
  assertEqual(badScheme.length, 0, `http(s) 아닌 링크 ${badScheme.length}건`);
});

test('인쇄 스타일이 조작 장치를 빼고 접힌 직무를 펼친다', (env) => {
  // jsdom 은 print 미디어를 적용하지 않으므로 규칙의 존재를 본다. 실제 렌더 확인은
  // 브라우저 인쇄 미리보기가 필요하다 - 여기서 지키려는 것은 "규칙이 사라지지
  // 않는 것"이다.
  const css = (Array.from(env.doc.querySelectorAll('style')) as any[])
    .map((el) => el.textContent)
    .join('\n');
  const at = css.indexOf('@media print');
  assert(at !== -1, '인쇄 스타일이 존재한다');

  // @media print 블록만 잘라낸다 (중첩 중괄호를 세어 끝을 찾는다)
  let depth = 0;
  let end = at;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const block = css.slice(at, end + 1);

  // 종이에서 누를 수 없는 것들이 빠져야 한다
  for (const sel of ['.sticky', '.card-cta', '.draft', '.role-toggle', '.count-row']) {
    assert(block.includes(sel), `인쇄에서 ${sel} 을 숨긴다`);
  }
  // 접힌 직무를 펼쳐야 한다. [hidden] 이 !important 라 덮어쓰기가 필요하다.
  assert(
    /\.role-list li\[hidden\]\s*\{[^}]*display:\s*flex\s*!important/.test(block),
    '접힌 직무를 인쇄에서 펼친다',
  );
  assert(/break-inside:\s*avoid/.test(block), '카드가 페이지 경계에서 쪼개지지 않는다');
  assert(/\.feed\s*\{[^}]*display:\s*block/.test(block), '인쇄에서는 한 열로 떨어진다');
});

test('도움말에 적힌 단축키는 모두 테스트로 덮여 있다', (env) => {
  // 도움말은 SHORTCUTS 상수에서 렌더되므로 "적혀 있다"는 것만으로는 배선을 보장하지
  // 않는다. 새 항목을 문서에만 추가하고 배선이나 테스트를 빼먹으면 도움말이 조용히
  // 거짓말을 한다. 아래 목록이 이 파일에서 실제로 눌러 본 키다.
  const tested = new Set([
    'j', 'k', 'd', 'm', '/', 'Esc', '1‒9', '0', 'v', 'h', 'u', 's', '?',
    'x', 'r', 'a', 'w',
  ]);

  const documented = (Array.from(env.doc.querySelectorAll('.help-row kbd')) as any[]).map(
    (el) => el.textContent.trim(),
  );
  assert(documented.length > 0, '도움말에 항목이 있다');

  const uncovered = documented.filter((k) => !tested.has(k));
  assertEqual(
    JSON.stringify(uncovered),
    '[]',
    `테스트가 없는 단축키: ${uncovered.join(', ')} — 배선을 확인하고 이 목록에 추가하세요`,
  );

  const stale = [...tested].filter((k) => !documented.includes(k));
  assertEqual(
    JSON.stringify(stale),
    '[]',
    `도움말에서 사라진 단축키: ${stale.join(', ')} — 목록을 정리하세요`,
  );
});

test('데이터 무결성: 리드가 한 건도 사라지지 않는다', (env) => {
  // 지금까지의 단정은 DOM 끼리 비교한다. 렌더러가 리드를 통째로 흘려도 내부 일관성은
  // 유지되므로 아무도 눈치채지 못한다. 원본과 대조해야 그걸 잡는다.
  //
  // 이 제품에서 리드가 조용히 사라지는 것은 가장 비싼 실패다 - 잘못된 리드는 보고
  // 버리면 되지만, 없는 리드는 존재를 모른다.
  assert(leads !== null, 'leads.json 을 읽었다');
  const total = leads!.summary.total;

  // 공고별 보기: 카드 수가 원본 총계와 같아야 한다
  assertEqual(env.allLeads().length, total, `공고 카드 ${env.allLeads().length} == ${total}`);

  // 회사별 보기: data-count 합이 총계와 같아야 한다
  const seats = (env.allGroups() as any[]).reduce(
    (s, el) => s + Number(el.getAttribute('data-count') || 0),
    0,
  );
  assertEqual(seats, total, `회사 카드의 자리 합 ${seats} == ${total}`);

  // 접기로 링크가 사라지지 않았는지. 직무를 묶어도 개별 공고 링크는 전부 남아야
  // 한다 - 근거를 확인할 수 없는 요약은 이 리포트에서 가치가 없다.
  let links = 0;
  for (const card of env.allGroups() as any[]) {
    const chips = card.querySelectorAll('.seat').length;
    const singles = card.querySelectorAll('.role-body > a').length;
    links += chips + singles;
  }
  assertEqual(links, total, `회사 카드의 자리 링크 ${links} == ${total}`);

  // 회사 수도 원본에서 센 것과 같아야 한다 (보드 기준으로 묶는다)
  const boards = new Set(leads!.leads.map((l) => l.board || l.company));
  assertEqual(env.allGroups().length, boards.size, `회사 카드 수 == 보드 수 ${boards.size}`);

  // 요약 숫자가 원본과 맞는지. 화면 숫자와 데이터가 어긋나면 사용자가 전체를 의심한다.
  const summaryNums = (Array.from(env.doc.querySelectorAll('.summary .n')) as any[]).map(
    (el) => Number(el.textContent),
  );
  assert(summaryNums.includes(total), `요약에 총 리드 수 ${total} 이 있다`);

  // hot 수는 leads.json 값을 그대로 믿지 않는다. 렌더러가 재사용 의심 건(2년 초과)을
  // hot 에서 내리므로, 같은 규칙을 적용한 기대값과 비교해야 한다. 원본 값을 그대로
  // 쓰면 이 의도된 보정이 회귀로 잡히고, 반대로 검사를 지우면 렌더러가 hot 개수를
  // 아무렇게나 표시해도 통과한다.
  const expectedHot = leads!.leads.filter(
    (l) => l.grade === 'hot' && !isAgeSuspect(l.ageDays),
  ).length;
  assert(
    summaryNums.includes(expectedHot),
    `요약에 보정된 hot ${expectedHot} 이 있다 (원본 ${leads!.summary.hot}, 의심 강등 ${leads!.summary.hot - expectedHot}건)`,
  );
  assertEqual(
    (env.doc.querySelectorAll('.grade-hot') as any).length,
    expectedHot,
    'hot 배지 개수도 보정값과 일치',
  );
  assert(
    summaryNums.includes(boards.size),
    `요약에 회사 수 ${boards.size} 가 있다`,
  );
});

test('데이터 무결성: 모든 링크가 원본 공고 URL 이다', (env) => {
  // 우리는 공고 본문을 재배포하지 않고 원문으로 보낸다. 링크가 원본 집합을 벗어나면
  // 그 원칙이 깨졌거나 URL 이 가공된 것이다.
  const known = new Set(leads!.leads.map((l) => l.jobUrl));

  const cardLinks = (Array.from(
    env.doc.querySelectorAll('.group-card a[target="_blank"], .card .title a'),
  ) as any[]).map((a) => a.getAttribute('href'));

  assert(cardLinks.length > 0, '링크가 있다');
  const foreign = cardLinks.filter((href) => !known.has(href));
  assertEqual(
    foreign.length,
    0,
    `원본에 없는 링크 ${foreign.length}건: ${foreign.slice(0, 2).join(' ')}`,
  );
});

test('접근성: 필터 컨트롤에 aria 상태가 있다', (env) => {
  for (const sel of ['.tab', '.seg-btn']) {
    const els = Array.from(env.doc.querySelectorAll(sel)) as any[];
    assert(els.length > 0, `${sel} 이 존재한다`);
    const missing = els.filter((el) => !el.hasAttribute('aria-pressed'));
    assertEqual(missing.length, 0, `${sel} 중 aria-pressed 누락 ${missing.length}건`);
  }
  assertEqual(
    env.byId('count').getAttribute('aria-live'),
    'polite',
    '결과 개수가 aria-live',
  );
  // 탭 개수 합이 전체와 맞는가. 어긋나면 사용자가 데이터를 의심한다.
  const all = Number(
    env.doc.querySelector('.tab[data-tab="all"] .tab-n').textContent,
  );
  const parts = Array.from(env.doc.querySelectorAll('.tab'))
    .filter((t: any) => t.getAttribute('data-tab') !== 'all')
    .reduce((s: number, t: any) => s + Number(t.querySelector('.tab-n').textContent), 0);
  assertEqual(parts, all, '탭 개수 합 == 전체');
});

/* ================================================================== *
 * 공개 티저 페이지 (docs/index.html)
 * ================================================================== *
 *
 * 이 페이지는 GitHub Pages 로 공개되는 유일한 산출물이고, 이 사업의 검증 장치다
 * (액세스 요청 이슈 수가 수요 지표). 그런데 검증이 전혀 없었다. 내부 리포트가
 * 깨지면 운영자만 불편하지만, 이쪽이 깨지면 측정 자체가 멈춘다.
 */

let publicHtml = '';

async function makePublicEnv(): Promise<Env> {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (err: unknown) => {
    failures.push({
      test: currentTest,
      message: `jsdom 스크립트 오류: ${(err as Error)?.message ?? String(err)}`,
    });
  });

  const dom = new JSDOM(publicHtml, {
    url: 'https://xiangbaej.github.io/hiresignal/',
    runScripts: 'dangerously',
    virtualConsole: vc,
  });
  const win = dom.window;
  const doc = win.document;
  const shown = (el: any): boolean => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hasAttribute('hidden')) return false;
    }
    return true;
  };
  const env: Env = {
    win,
    doc,
    shown,
    allGroups: () => [],
    allLeads: () => Array.from(doc.querySelectorAll('.card')),
    visibleGroups: () => [],
    visibleLeads: () =>
      Array.from(doc.querySelectorAll('.card')).filter((el: any) => shown(el)),
    byId: (id: string) => doc.getElementById(id),
    click: (el: any) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true })),
    key: () => {},
    type: async () => {},
    hash: () => win.location.hash,
    countText: () => '',
    settle: () => new Promise<void>((r) => win.setTimeout(r, 20)),
  };
  return env;
}

const publicTests: Array<[string, (env: Env) => Promise<void> | void]> = [];
function publicTest(name: string, fn: (env: Env) => Promise<void> | void): void {
  publicTests.push([name, fn]);
}

publicTest('티저 카드가 렌더된다', (env) => {
  const cards = env.visibleLeads();
  assertEqual(cards.length, 20, '무료 공개분은 20건');
  for (const c of cards) {
    assert(!!c.querySelector('.company'), '회사명이 있다');
    assert(!!c.querySelector('.title a'), '원문 링크가 걸린 제목이 있다');
    assert(!!c.querySelector('.why'), '판단 근거가 붙어 있다');
  }
});

publicTest('영어 페이지에 한국어가 새지 않는다', (env) => {
  // 실제로 있었던 결함이다. 내부 리포트와 카드 렌더 코드를 공유하므로 한국어 라벨이
  // 새기 쉽다. 사용자에게 보이는 텍스트만 본다 - 주석은 소스에 남아도 무해하다.
  const hangul = /[가-힣]/;
  const offenders: string[] = [];

  const walk = (node: any) => {
    for (const child of Array.from(node.childNodes) as any[]) {
      if (child.nodeType === 3) {
        const t = String(child.textContent).trim();
        if (t && hangul.test(t)) offenders.push(t.slice(0, 60));
      } else if (child.nodeType === 1 && child.tagName !== 'SCRIPT' && child.tagName !== 'STYLE') {
        walk(child);
      }
    }
  };
  walk(env.doc.body);

  // 속성으로 노출되는 텍스트도 본다 (title / placeholder / aria-label / alt)
  for (const el of Array.from(env.doc.querySelectorAll('*')) as any[]) {
    for (const attr of ['title', 'placeholder', 'aria-label', 'alt']) {
      const v = el.getAttribute(attr);
      if (v && hangul.test(v)) offenders.push(`[${attr}] ${v.slice(0, 60)}`);
    }
  }

  assertEqual(
    offenders.length,
    0,
    `한국어 노출 ${offenders.length}건: ${offenders.slice(0, 3).join(' / ')}`,
  );
  assertEqual(env.doc.documentElement.getAttribute('lang'), 'en', 'lang 은 en');
});

publicTest('액세스 요청이 GitHub 이슈 URL 을 만든다', (env) => {
  // 폼 백엔드가 없어 이슈로 보낸다. 이 경로가 막히면 수요 측정이 멈춘다.
  let opened: any = null;
  env.win.open = (url: string) => {
    opened = url;
    return null;
  };

  const form = env.byId('lead-form');
  assert(!!form, '요청 폼이 있다');

  // 스택이 비면 아무 일도 없어야 한다 (빈 이슈를 만들면 지표가 오염된다)
  env.byId('stacks').value = '';
  form.dispatchEvent(new env.win.Event('submit', { bubbles: true, cancelable: true }));
  assertEqual(opened, null, '스택이 비면 이슈를 열지 않는다');

  env.byId('stacks').value = 'kubernetes, terraform';
  env.byId('email').value = 'me@example.com';
  form.dispatchEvent(new env.win.Event('submit', { bubbles: true, cancelable: true }));

  assert(!!opened, '이슈 URL 을 연다');
  assert(String(opened).startsWith('https://github.com/'), `github.com 으로 간다: ${opened}`);
  assert(String(opened).includes('/issues/new'), '새 이슈 경로');
  const decoded = decodeURIComponent(String(opened));
  assert(decoded.includes('kubernetes, terraform'), '입력한 스택이 담긴다');
  assert(decoded.includes('me@example.com'), '입력한 이메일이 담긴다');

  // 이메일은 선택 사항이다. 공개 이슈라 넣지 않으면 넣지 않아야 한다.
  opened = null;
  env.byId('email').value = '';
  form.dispatchEvent(new env.win.Event('submit', { bubbles: true, cancelable: true }));
  assert(!decodeURIComponent(String(opened)).includes('Preferred contact'),
    '이메일을 비우면 연락처 절이 빠진다');
});

publicTest('외부 링크가 안전 속성을 갖고 원문으로 나간다', (env) => {
  const links = Array.from(env.doc.querySelectorAll('a[target="_blank"]')) as any[];
  assert(links.length > 0, '외부 링크가 있다');
  const unsafe = links.filter((a) => {
    const rel = a.getAttribute('rel') || '';
    return !rel.includes('noopener') || !rel.includes('noreferrer');
  });
  assertEqual(unsafe.length, 0, `rel 누락 ${unsafe.length}건`);

  const bad = links.filter((a) => !/^https?:/.test(a.getAttribute('href') || ''));
  assertEqual(bad.length, 0, `http(s) 아닌 링크 ${bad.length}건`);
});

publicTest('공고 본문을 재배포하지 않는다', (env) => {
  // 데이터 취급 원칙이다. 제목·회사·URL·파생 태그만 담고 본문은 담지 않는다.
  // 카드 텍스트가 길어지면 본문이 섞여 들어갔다는 신호다.
  for (const card of env.visibleLeads()) {
    const text = String(card.textContent).replace(/\s+/g, ' ').trim();
    assert(
      text.length < 1200,
      `카드 텍스트가 과하게 길다(${text.length}자) — 본문이 섞였을 수 있다`,
    );
  }
});

publicTest('다크 모드 토큰이 공개 페이지에도 있다', (env) => {
  const css = (Array.from(env.doc.querySelectorAll('style')) as any[])
    .map((el) => el.textContent)
    .join('\n');
  assert(css.includes('@media (prefers-color-scheme: dark)'), '다크 모드 블록이 있다');
  for (const tok of ['--on-primary', '--line-strong']) {
    assert(css.includes(tok), `${tok} 토큰이 정의돼 있다`);
  }
});

/* ================================================================== *
 * 실행
 * ================================================================== */

/**
 * 케이스 목록을 돌린다. 각 케이스는 새 문서에서 시작한다.
 *
 * 테스트 간 localStorage 격리를 따로 하지 않는다. jsdom 은 인스턴스 사이에 저장소를
 * 공유하지 않으므로 새 문서는 항상 빈 저장소로 출발한다 - 그 성질 때문에 "다음 방문"
 * 재현에는 beforeParse 로 심어야 했다. 같은 이유로 여기서 비울 것도 없다.
 */
async function runSuite(
  label: string,
  list: Array<[string, (env: Env) => Promise<void> | void]>,
  factory: () => Promise<Env>,
): Promise<void> {
  console.log(label);
  for (const [name, fn] of list) {
    currentTest = name;
    const before = failures.length;
    let env: Env | null = null;
    try {
      env = await factory();
      await fn(env);
    } catch (err) {
      failures.push({ test: name, message: `예외: ${(err as Error).message}` });
    } finally {
      try { env?.win.close(); } catch {}
    }
    const failed = failures.length - before;
    if (failed === 0) {
      passedTests++;
      console.log(`  PASS  ${name}`);
    } else {
      console.log(`  FAIL  ${name}`);
      // 같은 단정이 루프에서 수백 번 실패하면 원인이 로그에 묻힌다. 접어서 보여준다.
      const seen = new Map<string, number>();
      for (const f of failures.slice(before)) {
        seen.set(f.message, (seen.get(f.message) ?? 0) + 1);
      }
      for (const [msg, n] of seen) {
        console.log(`          ${msg}${n > 1 ? `  (x${n})` : ''}`);
      }
    }
  }
  console.log('');
}

async function main(): Promise<void> {
  html = await readFile(REPORT, 'utf8');
  publicHtml = await readFile(PUBLIC, 'utf8');
  leads = JSON.parse(await readFile(LEADS, 'utf8')) as LeadsFile;

  const kb = (s: string) => (s.length / 1024).toFixed(0);
  console.log(
    `대상: data/report.html (${kb(html)} KB) · docs/index.html (${kb(publicHtml)} KB)`,
  );
  console.log('');

  const startedAt = Date.now();
  await runSuite('[내부 리포트]', tests, () => makeEnv());
  await runSuite('[공개 티저]', publicTests, makePublicEnv);

  const totalTests = tests.length + publicTests.length;
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `${passedTests}/${totalTests} 테스트 통과 · 단정 ${assertions}개 · ${secs}초` +
      (failures.length ? ` · 실패 ${failures.length}건` : ''),
  );
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('오류:', e);
  process.exit(1);
});
