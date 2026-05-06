import type { AuthoredContentPack } from '../../../lib/contentTypes';
import { applyLevel1EditorialRewrite, type Level1EditorialConfig } from './editorialRewrite';

const config: Level1EditorialConfig = {
  topicId: 'quant-methods',
  author: 'QuantVault editorial desk',
  reviewer: 'QuantVault quantitative methods reviewer',
  reviewedAt: '2026-05-05',
  evidenceBase: 'level1-quant-methods-2026-editorial',
  decisionFrame: 'Quantitative methods items reward choosing the correct statistic, time-value setup, probability rule, or inference step before computing.',
  scenarios: [
    'A candidate compares cash flows with different timing conventions',
    'An analyst reviews sample statistics before interpreting dispersion',
    'A research associate evaluates a confidence interval for a manager report',
    'A junior analyst checks whether regression output supports an investment claim',
  ],
  decisions: [
    'select the statistic or cash-flow setup that fits the prompt',
    'interpret dispersion, probability, or sampling evidence correctly',
    'choose the inference conclusion supported by the test result',
    'identify the model limitation before using the estimate',
  ],
  traps: [
    'mixing arithmetic and geometric averages',
    'using nominal rates when the prompt asks for an effective rate',
    'treating statistical significance as economic importance',
    'reading correlation as proof of causation',
  ],
  datasetRows: [
    { period: 1, cashFlow: -1000, return: '4.2%', probability: '20%' },
    { period: 2, cashFlow: 360, return: '-1.4%', probability: '30%' },
    { period: 3, cashFlow: 410, return: '7.8%', probability: '35%' },
    { period: 4, cashFlow: 455, return: '3.1%', probability: '15%' },
  ],
};

export function buildQuantMethodsPack(pack: AuthoredContentPack): AuthoredContentPack {
  return applyLevel1EditorialRewrite(pack, config);
}
