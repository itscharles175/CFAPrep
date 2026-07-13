import type { AuthoredContentPack } from '../../../lib/contentTypes';
import { applyLevel1EditorialRewrite, type Level1EditorialConfig } from './editorialRewrite';

const config: Level1EditorialConfig = {
  topicId: 'economics',
  author: 'QuantVault editorial desk',
  reviewer: 'QuantVault economics reviewer',
  reviewedAt: '2026-05-05',
  evidenceBase: 'level1-economics-2026-editorial',
  decisionFrame: 'Economics items reward linking the market, policy, trade, currency, or macro indicator to the directional implication requested.',
  scenarios: [
    'An analyst reviews a central bank statement after inflation rises',
    'A candidate evaluates how a tariff changes domestic supply and demand',
    'A strategist compares two currencies using interest-rate evidence',
    'A junior analyst interprets an output gap and unemployment report',
  ],
  decisions: [
    'identify the market effect of the demand or supply change',
    'interpret the policy transmission channel supported by the facts',
    'select the currency or trade implication that follows from parity logic',
    'connect macro indicators to the business-cycle conclusion',
  ],
  traps: [
    'shifting demand when the prompt changes supply',
    'confusing nominal and real interest-rate effects',
    'quoting the currency pair in the wrong direction',
    'assuming policy intent equals the final economic outcome',
  ],
  datasetRows: [
    { indicator: 'inflation', current: '3.8%', prior: '2.9%', interpretation: 'price pressure rising' },
    { indicator: 'unemployment', current: '5.2%', prior: '5.8%', interpretation: 'labor market improving' },
    { indicator: 'policy rate', current: '4.50%', prior: '4.00%', interpretation: 'monetary stance tighter' },
    { indicator: 'currency quote', current: '1.18 USD/EUR', prior: '1.12 USD/EUR', interpretation: 'euro stronger' },
  ],
};

export function buildEconomicsPack(pack: AuthoredContentPack): AuthoredContentPack {
  return applyLevel1EditorialRewrite(pack, config);
}
