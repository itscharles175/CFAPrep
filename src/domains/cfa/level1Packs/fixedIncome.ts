import type { AuthoredContentPack } from '../../../lib/contentTypes';
import { applyLevel1EditorialRewrite, type Level1EditorialConfig } from './editorialRewrite';

const config: Level1EditorialConfig = {
  topicId: 'fixed-income',
  author: 'QuantVault editorial desk',
  reviewer: 'QuantVault fixed income reviewer',
  reviewedAt: '2026-05-05',
  evidenceBase: 'level1-fixed-income-2026-editorial',
  decisionFrame: 'Fixed income items reward a clean link from bond feature, cash-flow timing, yield, duration, convexity, or credit fact to the requested interpretation.',
  scenarios: [
    'A portfolio analyst compares two investment-grade bonds after a rate move',
    'A risk analyst reviews a callable bond position before a client meeting',
    'A junior analyst checks whether spread or duration explains a price change',
    'A candidate evaluates securitized cash-flow timing under a simple stress case',
  ],
  decisions: [
    'select the yield measure that matches the quoted price',
    'interpret duration and convexity after an interest-rate change',
    'separate credit spread risk from benchmark rate risk',
    'identify the bond feature that changes reinvestment or call risk',
  ],
  traps: [
    'treating yield to maturity as a realized return',
    'using modified duration without checking the direction of the rate change',
    'mixing issuer spread risk with Treasury curve movement',
    'ignoring an embedded option when rates fall',
  ],
  datasetRows: [
    { bond: 'Alpha 2029', coupon: '4.20%', price: 98.4, yield: '4.62%', duration: 4.1, spread: '92 bp' },
    { bond: 'Beta 2031 callable', coupon: '5.10%', price: 101.2, yield: '4.86%', duration: 5.3, spread: '118 bp' },
    { bond: 'Gamma floater', coupon: 'SOFR + 85 bp', price: 99.7, yield: 'reset dependent', duration: 0.4, spread: '85 bp' },
    { bond: 'Delta mortgage pool', coupon: '3.75%', price: 96.9, yield: 'path dependent', duration: 3.8, spread: '143 bp' },
  ],
};

export function buildFixedIncomePack(pack: AuthoredContentPack): AuthoredContentPack {
  return applyLevel1EditorialRewrite(pack, config);
}
