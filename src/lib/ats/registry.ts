/**
 * 커넥터 레지스트리.
 *
 * 새 ATS를 추가할 때 파이프라인 코드를 건드리지 않도록 여기서만 등록한다.
 * 파이프라인은 provider 문자열로 커넥터를 조회할 뿐이다.
 */

import { ashbyConnector } from './ashby.js';
import { greenhouseConnector } from './greenhouse.js';
import { leverConnector } from './lever.js';
import { smartRecruitersConnector } from './smartrecruiters.js';
import { ATS_PROVIDERS, type AtsConnector, type AtsProvider } from './types.js';

const CONNECTORS: Record<AtsProvider, AtsConnector> = {
  greenhouse: greenhouseConnector,
  lever: leverConnector,
  ashby: ashbyConnector,
  smartrecruiters: smartRecruitersConnector,
};

export function getConnector(provider: AtsProvider): AtsConnector {
  const connector = CONNECTORS[provider];
  if (!connector) {
    throw new Error(`등록되지 않은 ATS provider: ${provider}`);
  }
  return connector;
}

export function isAtsProvider(value: string): value is AtsProvider {
  return (ATS_PROVIDERS as readonly string[]).includes(value);
}

export const allConnectors: readonly AtsConnector[] = Object.values(CONNECTORS);

export { ATS_PROVIDERS };
export type { AtsConnector, AtsProvider };
