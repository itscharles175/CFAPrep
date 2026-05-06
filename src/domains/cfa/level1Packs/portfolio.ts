import type { AuthoredContentPack } from '../../../lib/contentTypes';
import { applyLevel1EditorialRewrite, type Level1EditorialConfig } from './editorialRewrite';

const config: Level1EditorialConfig = {
  topicId: 'portfolio',
  author: 'QuantVault editorial desk',
  reviewer: 'QuantVault portfolio management reviewer',
  reviewedAt: '2026-05-05',
  evidenceBase: 'level1-portfolio-2026-editorial',
  decisionFrame: 'Portfolio management items reward linking risk, return, correlation, client constraint, benchmark, and allocation effect to the best portfolio decision.',
  scenarios: [
    'An adviser reviews a two-asset allocation after volatility changes',
    'A candidate compares portfolio risk before and after adding a diversifier',
    'A junior analyst evaluates whether benchmark-relative performance improved',
    'A planner checks whether a client constraint changes the recommended allocation',
  ],
  decisions: [
    'interpret how diversification changes expected risk',
    'select the performance or risk measure that fits the prompt',
    'connect the client constraint to an allocation decision',
    'identify the benchmark implication of active return or tracking error',
  ],
  traps: [
    'averaging risks without using correlation',
    'choosing the highest return without checking risk',
    'ignoring liquidity or time horizon constraints',
    'treating active return as risk-adjusted performance',
  ],
  datasetRows: [
    { asset: 'Global equity', expectedReturn: '7.4%', standardDeviation: '16.2%', correlationCue: '0.62 with portfolio' },
    { asset: 'Core bonds', expectedReturn: '4.1%', standardDeviation: '5.8%', correlationCue: '0.18 with equity' },
    { asset: 'Real assets', expectedReturn: '6.2%', standardDeviation: '12.5%', correlationCue: '0.41 with equity' },
    { asset: 'Cash reserve', expectedReturn: '2.8%', standardDeviation: '0.7%', correlationCue: 'near zero' },
  ],
};

export function buildPortfolioPack(pack: AuthoredContentPack): AuthoredContentPack {
  return applyLevel1EditorialRewrite(pack, config);
}
