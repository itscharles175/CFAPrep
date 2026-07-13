import type { AuthoredContentPack } from '../../../lib/contentTypes';
import { applyLevel1EditorialRewrite, type Level1EditorialConfig } from './editorialRewrite';

const config: Level1EditorialConfig = {
  topicId: 'equity',
  author: 'QuantVault editorial desk',
  reviewer: 'QuantVault equity reviewer',
  reviewedAt: '2026-05-05',
  evidenceBase: 'level1-equity-2026-editorial',
  decisionFrame: 'Equity items reward matching company economics, market structure, valuation input, and ownership claim to the requested conclusion.',
  scenarios: [
    'An analyst compares two firms with different dividend policies',
    'A candidate evaluates whether an industry has high entry barriers',
    'A portfolio analyst reviews a price multiple after a margin change',
    'A junior analyst checks how voting rights affect a share class comparison',
  ],
  decisions: [
    'select the valuation input that best matches the company facts',
    'interpret market or industry structure from the evidence',
    'connect dividend policy to expected shareholder return',
    'identify the ownership right that changes the investment conclusion',
  ],
  traps: [
    'using a low multiple without checking growth and risk',
    'treating accounting earnings as free cash flow',
    'ignoring control rights when comparing share classes',
    'assuming a mature industry has no competitive pressure',
  ],
  datasetRows: [
    { company: 'Aster Foods', pe: 18.4, growth: '6%', margin: '11%', dividendYield: '2.1%' },
    { company: 'Beacon Software', pe: 31.2, growth: '14%', margin: '23%', dividendYield: '0.0%' },
    { company: 'Cobalt Utilities', pe: 15.1, growth: '3%', margin: '18%', dividendYield: '4.6%' },
    { company: 'Dune Retail', pe: 12.8, growth: '4%', margin: '7%', dividendYield: '1.5%' },
  ],
};

export function buildEquityPack(pack: AuthoredContentPack): AuthoredContentPack {
  return applyLevel1EditorialRewrite(pack, config);
}
