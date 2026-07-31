/**
 * jsdom 의 최소 타입 선언.
 *
 * ── 왜 @types/jsdom 을 받지 않는가 ──
 *
 * 우리가 쓰는 표면은 JSDOM 생성자와 window 뿐이다. 전체 DOM 타입을 끌어오려면
 * tsconfig 의 lib 에 "DOM" 을 넣어야 하는데, 이 프로젝트는 Node 전용이고 lib 을
 * ES2023 으로 좁혀 둔 상태다. DOM 을 전역에 열면 서버 코드에서 document 같은
 * 식별자가 컴파일을 통과해 버려, 런타임에만 터지는 실수를 타입 검사가 놓친다.
 *
 * 그래서 테스트 대상인 window 는 any 로 둔다. 여기서 타입 안전성을 얻는 것은
 * 목적이 아니다 - 이 파일의 소비자는 UI 행동 테스트 하나뿐이고, 그 테스트의
 * 검증 수단은 타입이 아니라 실제 실행 결과다.
 */
declare module 'jsdom' {
  export interface JsdomOptions {
    /**
     * 오리진. localStorage 와 history.replaceState 는 불투명 오리진에서 막히므로
     * about:blank 가 아닌 http(s) URL 을 주어야 한다.
     */
    url?: string;
    /** 인라인 <script> 실행 여부. 리포트 동작을 검증하려면 dangerously 가 필요하다. */
    runScripts?: 'dangerously' | 'outside-only';
    pretendToBeVisual?: boolean;
    virtualConsole?: VirtualConsole;
    /**
     * 파싱 직전 훅. 인라인 스크립트가 읽기 전에 localStorage 를 심는 데 쓴다 —
     * jsdom 은 인스턴스 간 저장소를 공유하지 않으므로 "다음 방문"을 재현하는
     * 유일한 경로다.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    beforeParse?(window: any): void;
  }

  export class VirtualConsole {
    on(event: string, handler: (...args: unknown[]) => void): this;
    sendTo(target: unknown): this;
  }

  export class JSDOM {
    constructor(html: string, options?: JsdomOptions);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readonly window: any;
    serialize(): string;
  }
}
