import type { AuthoredContentPack } from '../../../lib/contentTypes';
import { buildAlternativesPack } from './alternatives';
import { buildCorporatePack } from './corporate';
import { buildDerivativesPack } from './derivatives';
import { buildEconomicsPack } from './economics';
import { buildEquityPack } from './equity';
import { buildEthicsPack } from './ethics';
import { buildFixedIncomePack } from './fixedIncome';
import { buildFsaPack } from './fsa';
import { buildPortfolioPack } from './portfolio';
import { buildQuantMethodsPack } from './quantMethods';

export const level1EditorialSprintOrder = [
  'fixed-income',
  'ethics',
  'fsa',
  'equity',
  'quant-methods',
  'economics',
  'corporate',
  'portfolio',
  'derivatives',
  'alternatives',
] as const;

const builders: Record<string, (pack: AuthoredContentPack) => AuthoredContentPack> = {
  'fixed-income': buildFixedIncomePack,
  ethics: buildEthicsPack,
  fsa: buildFsaPack,
  equity: buildEquityPack,
  'quant-methods': buildQuantMethodsPack,
  economics: buildEconomicsPack,
  corporate: buildCorporatePack,
  portfolio: buildPortfolioPack,
  derivatives: buildDerivativesPack,
  alternatives: buildAlternativesPack,
};

export function buildLevel1EditorialPacks(packs: AuthoredContentPack[]): AuthoredContentPack[] {
  return packs.map((pack) => {
    const builder = builders[pack.topicId];
    return builder ? builder(pack) : pack;
  });
}
