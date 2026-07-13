import type { AuthoredContentPack } from '../../../lib/contentTypes';
import { applyLevel1EditorialRewrite, type Level1EditorialConfig } from './editorialRewrite';

const config: Level1EditorialConfig = {
  topicId: 'corporate',
  author: 'QuantVault editorial desk',
  reviewer: 'QuantVault corporate issuers reviewer',
  reviewedAt: '2026-05-05',
  evidenceBase: 'level1-corporate-2026-editorial',
  decisionFrame: 'Corporate issuer items reward connecting project cash flows, financing choice, working-capital policy, and governance facts to shareholder value.',
  scenarios: [
    'A finance team compares two expansion projects with different timing',
    'A treasurer evaluates whether leverage has increased financial risk',
    'A candidate reviews a working-capital policy before a liquidity meeting',
    'A board committee checks whether governance controls reduce agency risk',
  ],
  decisions: [
    'select the capital budgeting conclusion supported by incremental cash flows',
    'interpret the financing choice and cost-of-capital implication',
    'identify the working-capital action that improves liquidity discipline',
    'connect governance facts to shareholder protection',
  ],
  traps: [
    'including sunk costs in the project decision',
    'treating lower coupon debt as lower overall risk',
    'maximizing sales without checking receivables collection',
    'confusing board independence with day-to-day management',
  ],
  datasetRows: [
    { project: 'Plant upgrade', outlay: 220, yearOneCashFlow: 62, wacc: '8.4%', governanceFlag: 'independent audit chair' },
    { project: 'Distribution center', outlay: 180, yearOneCashFlow: 44, wacc: '7.9%', governanceFlag: 'related-party review' },
    { project: 'Automation line', outlay: 140, yearOneCashFlow: 39, wacc: '8.8%', governanceFlag: 'risk committee review' },
    { project: 'Software rollout', outlay: 75, yearOneCashFlow: 28, wacc: '9.1%', governanceFlag: 'board approval threshold' },
  ],
};

export function buildCorporatePack(pack: AuthoredContentPack): AuthoredContentPack {
  return applyLevel1EditorialRewrite(pack, config);
}
