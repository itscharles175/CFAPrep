import type { AuthoredContentPack } from '../../../lib/contentTypes';
import { applyLevel1EditorialRewrite, type Level1EditorialConfig } from './editorialRewrite';

const config: Level1EditorialConfig = {
  topicId: 'derivatives',
  author: 'QuantVault editorial desk',
  reviewer: 'QuantVault derivatives reviewer',
  reviewedAt: '2026-05-05',
  evidenceBase: 'level1-derivatives-2026-editorial',
  decisionFrame: 'Derivatives items reward matching contract type, payoff direction, settlement timing, and hedge objective before applying pricing or payoff logic.',
  scenarios: [
    'A risk manager uses futures to hedge a planned commodity purchase',
    'A candidate compares option payoffs at expiration',
    'A treasury analyst reviews a forward contract before settlement',
    'A junior analyst checks whether a swap position benefits from a rate move',
  ],
  decisions: [
    'identify the payoff direction from the contract terms',
    'select the hedge action that offsets the underlying exposure',
    'interpret no-arbitrage pricing from carry and settlement facts',
    'connect option moneyness to intrinsic value and exercise logic',
  ],
  traps: [
    'reversing the long and short payoff',
    'hedging the price risk in the same direction as the exposure',
    'using spot price while ignoring carry or settlement timing',
    'treating option premium as intrinsic value',
  ],
  datasetRows: [
    { contract: 'Equity call', underlying: 52, strike: 50, premium: 3.4, position: 'long' },
    { contract: 'Commodity future', underlying: 88, strike: 0, premium: 0, position: 'short hedge' },
    { contract: 'Currency forward', underlying: 1.24, strike: 1.21, premium: 0, position: 'long base currency' },
    { contract: 'Pay-fixed swap', underlying: 'rate rises', strike: 'fixed leg 4.1%', premium: 0, position: 'payer' },
  ],
};

export function buildDerivativesPack(pack: AuthoredContentPack): AuthoredContentPack {
  return applyLevel1EditorialRewrite(pack, config);
}
