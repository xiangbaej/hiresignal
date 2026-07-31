/**
 * 리포트 UI 행동 테스트.
 *
 *   npm run ui:test
 *
 * ── 왜 필요한가 ──
 *
 * data/report.html 의 인라인 스크립트는 이제 상태 기계다. 필터 4종(탭·검색·Hot·
 * 미연락)이 합성되고, 그 상태가 URL 해시로 왕복하며, 연락 이력은 localStorage 에
 * 남고, 보기 전환이 정렬과 필터를 함께 되돌린다. 이 정도 결합은 생성물을 정규식으로
 * 훑어서는 검증되지 않는다 - "속성이 있다"와 "눌렀을 때 의도대로 동작한다"는 다른
 * 주장이다.
 *
 * 실제로 정적 검사만 하던 동안 두 건의 결함이 사람 눈에만 걸렸다.
 *   - `.feed { display:flex }` 가 [hidden] 을 덮어 두 피드가 동시에 렌더된 것
 *   - 셀렉트 정렬 변경이 URL 에 저장되지 않은 것(단축키 경로만 저장)
 * 둘 다 "클릭하고 결과를 본다"로 즉시 잡히는 종류다.
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REPORT = path.join(ROOT, 'data', 'report.html');

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

test('도움말에 적힌 단축키는 모두 테스트로 덮여 있다', (env) => {
  // 도움말은 SHORTCUTS 상수에서 렌더되므로 "적혀 있다"는 것만으로는 배선을 보장하지
  // 않는다. 새 항목을 문서에만 추가하고 배선이나 테스트를 빼먹으면 도움말이 조용히
  // 거짓말을 한다. 아래 목록이 이 파일에서 실제로 눌러 본 키다.
  const tested = new Set(['j', 'k', 'd', 'm', '/', 'Esc', '1‒9', '0', 'v', 'h', 'u', 's', '?']);

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
 * 실행
 * ================================================================== */

async function main(): Promise<void> {
  html = await readFile(REPORT, 'utf8');
  console.log(`대상: data/report.html (${(html.length / 1024).toFixed(0)} KB)`);
  console.log('');

  for (const [name, fn] of tests) {
    currentTest = name;
    const before = failures.length;
    let env: Env | null = null;
    try {
      env = await makeEnv();
      // 테스트 간 격리. localStorage 는 오리진 단위로 공유되므로 문서를 만든 직후
      // 비우고, 스크립트가 이미 읽은 상태를 지우기 위해 다시 만든다.
      env.win.localStorage.clear();
      env.win.close();
      env = await makeEnv();
      await fn(env);
    } catch (err) {
      failures.push({ test: name, message: `예외: ${(err as Error).message}` });
    } finally {
      try { env?.win.localStorage.clear(); } catch {}
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
  console.log(
    `${passedTests}/${tests.length} 테스트 통과 · 단정 ${assertions}개` +
      (failures.length ? ` · 실패 ${failures.length}건` : ''),
  );
  if (failures.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('오류:', e);
  process.exit(1);
});
