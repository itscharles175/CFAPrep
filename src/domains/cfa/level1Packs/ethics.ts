import type { AuthoredContentPack } from '../../../lib/contentTypes';
import { applyLevel1EditorialRewrite, type Level1EditorialConfig } from './editorialRewrite';

const config: Level1EditorialConfig = {
  topicId: 'ethics',
  author: 'QuantVault editorial desk',
  reviewer: 'QuantVault ethics reviewer',
  reviewedAt: '2026-05-05',
  evidenceBase: 'level1-ethics-2026-editorial',
  decisionFrame: 'Ethics items reward careful identification of the stakeholder, duty, conflict, disclosure need, and action that preserves professional conduct.',
  scenarios: [
    'An analyst receives issuer-sponsored travel before publishing research',
    'A portfolio manager allocates a limited IPO across eligible client accounts',
    'A supervisor reviews a junior analyst note with unsupported performance claims',
    'A candidate hears client-specific information during a private meeting',
  ],
  decisions: [
    'choose the action that preserves independence and objectivity',
    'identify the disclosure or consent step required before acting',
    'distinguish fair dealing from preferential treatment',
    'select the conduct response that protects market integrity',
  ],
  traps: [
    'assuming disclosure cures every conflict',
    'favoring the largest client because the allocation is small',
    'using firm approval as a substitute for reasonable basis',
    'trading before determining whether information is material and nonpublic',
  ],
  datasetRows: [
    { case: 'issuer visit', stakeholder: 'research clients', conflict: 'paid travel', action: 'disclose and preserve independence' },
    { case: 'IPO allocation', stakeholder: 'eligible clients', conflict: 'limited supply', action: 'follow documented allocation policy' },
    { case: 'performance note', stakeholder: 'prospective clients', conflict: 'unsupported claim', action: 'correct or remove the claim' },
    { case: 'private meeting', stakeholder: 'market participants', conflict: 'selective information', action: 'do not trade on material nonpublic information' },
  ],
};

export function buildEthicsPack(pack: AuthoredContentPack): AuthoredContentPack {
  return applyLevel1EditorialRewrite(pack, config);
}
