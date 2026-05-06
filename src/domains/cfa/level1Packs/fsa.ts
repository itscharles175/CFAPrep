import type { AuthoredContentPack } from '../../../lib/contentTypes';
import { applyLevel1EditorialRewrite, type Level1EditorialConfig } from './editorialRewrite';

const config: Level1EditorialConfig = {
  topicId: 'fsa',
  author: 'QuantVault editorial desk',
  reviewer: 'QuantVault FSA reviewer',
  reviewedAt: '2026-05-05',
  evidenceBase: 'level1-fsa-2026-editorial',
  decisionFrame: 'FSA items reward linking the statement account, accounting choice, ratio effect, and analyst adjustment before selecting an interpretation.',
  scenarios: [
    'An analyst compares two manufacturers with different inventory methods',
    'A credit analyst reviews cash-flow classification for a retailer',
    'A candidate evaluates whether profitability improved because of margin or turnover',
    'An equity analyst adjusts lease information before comparing leverage',
  ],
  decisions: [
    'identify the statement effect of the accounting choice',
    'interpret liquidity, solvency, or profitability from the ratio evidence',
    'separate cash-flow quality from accrual earnings',
    'select the adjustment that improves comparability',
  ],
  traps: [
    'reading net income without checking cash flow',
    'comparing ratios before normalizing the accounting choice',
    'treating a classification change as an operating improvement',
    'ignoring balance-sheet effects of an analyst adjustment',
  ],
  datasetRows: [
    { company: 'Northstar Tools', revenue: 820, grossMargin: '34%', inventoryDays: 71, debtToAssets: '42%' },
    { company: 'Harbor Retail', revenue: 640, grossMargin: '29%', inventoryDays: 48, debtToAssets: '55%' },
    { company: 'Mesa Components', revenue: 510, grossMargin: '37%', inventoryDays: 83, debtToAssets: '39%' },
    { company: 'Cedar Services', revenue: 470, grossMargin: '41%', inventoryDays: 22, debtToAssets: '31%' },
  ],
};

export function buildFsaPack(pack: AuthoredContentPack): AuthoredContentPack {
  return applyLevel1EditorialRewrite(pack, config);
}
