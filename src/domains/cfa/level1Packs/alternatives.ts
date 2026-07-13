import type { AuthoredContentPack } from '../../../lib/contentTypes';
import { applyLevel1EditorialRewrite, type Level1EditorialConfig } from './editorialRewrite';

const config: Level1EditorialConfig = {
  topicId: 'alternatives',
  author: 'QuantVault editorial desk',
  reviewer: 'QuantVault alternatives reviewer',
  reviewedAt: '2026-05-05',
  evidenceBase: 'level1-alternatives-2026-editorial',
  decisionFrame: 'Alternative investment items reward connecting structure, liquidity, valuation basis, fee term, and risk source to the requested conclusion.',
  scenarios: [
    'An analyst compares private equity and public equity exposure',
    'A candidate reviews real estate income and appraisal information',
    'A portfolio analyst evaluates a hedge fund fee example',
    'A junior analyst checks commodity exposure during an inflation scenario',
  ],
  decisions: [
    'identify the risk or liquidity feature that changes the allocation decision',
    'interpret valuation evidence when market prices are limited',
    'select the fee or return calculation supported by the facts',
    'connect the alternative asset role to portfolio diversification',
  ],
  traps: [
    'treating appraisal value as a traded market price',
    'ignoring lockups and redemption gates',
    'subtracting fees from the wrong base',
    'assuming all alternatives hedge inflation equally',
  ],
  datasetRows: [
    { vehicle: 'Core real estate', liquidity: 'quarterly', fee: '1.0%', valuationBasis: 'appraisal and income' },
    { vehicle: 'Private equity fund', liquidity: 'multi-year lockup', fee: '2 and 20', valuationBasis: 'company marks' },
    { vehicle: 'Commodity index', liquidity: 'daily', fee: '0.35%', valuationBasis: 'futures roll' },
    { vehicle: 'Long-short fund', liquidity: 'monthly notice', fee: '1.5 and 15', valuationBasis: 'portfolio marks' },
  ],
};

export function buildAlternativesPack(pack: AuthoredContentPack): AuthoredContentPack {
  return applyLevel1EditorialRewrite(pack, config);
}
