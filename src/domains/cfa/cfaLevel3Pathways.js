export const DEFAULT_LEVEL3_PATHWAY = 'portfolio-management';
export const LEVEL3_LIBRARY_MODE = 'all-pathways-library';
export const LEVEL3_PATHWAY_STORAGE_KEY = 'quantvault:level3-pathway';
export const LEVEL3_PATHWAY_EVENT = 'quantvault:level3-pathway-change';

export const LEVEL3_CORE_TOPIC_IDS = ['ethics', 'asset-allocation', 'portfolio-construction', 'performance', 'derivatives-risk'];

export const LEVEL3_PATHWAY_TOPICS = {
  'portfolio-management': 'pm-pathway',
  'private-markets': 'private-markets-pathway',
  'private-wealth': 'private-wealth-pathway',
};

export const LEVEL3_PATHWAY_OPTIONS = [
  { value: 'portfolio-management', label: 'Portfolio Management' },
  { value: 'private-markets', label: 'Private Markets' },
  { value: 'private-wealth', label: 'Private Wealth' },
];

const PATHWAY_BY_TOPIC = Object.fromEntries(Object.entries(LEVEL3_PATHWAY_TOPICS).map(([pathway, topicId]) => [topicId, pathway]));
const CORE_TOPIC_SET = new Set(LEVEL3_CORE_TOPIC_IDS);

export function normalizeLevel3Pathway(pathway = DEFAULT_LEVEL3_PATHWAY) {
  return LEVEL3_PATHWAY_TOPICS[pathway] ? pathway : DEFAULT_LEVEL3_PATHWAY;
}

export function level3PathwayTopicId(pathway = DEFAULT_LEVEL3_PATHWAY) {
  return LEVEL3_PATHWAY_TOPICS[normalizeLevel3Pathway(pathway)];
}

export function level3PathwayForTopic(topicId) {
  const bareTopic = String(topicId || '').split(':').at(-1);
  if (CORE_TOPIC_SET.has(bareTopic)) return 'core';
  return PATHWAY_BY_TOPIC[bareTopic] || null;
}

export function level3TopicBelongsToPathway(topicId, pathway = DEFAULT_LEVEL3_PATHWAY) {
  const topicPathway = level3PathwayForTopic(topicId);
  return topicPathway === 'core' || topicPathway === normalizeLevel3Pathway(pathway);
}

export function level3PathwayFromStorage(storage = globalThis?.localStorage) {
  try {
    return normalizeLevel3Pathway(storage?.getItem(LEVEL3_PATHWAY_STORAGE_KEY));
  } catch {
    return DEFAULT_LEVEL3_PATHWAY;
  }
}

export function writeLevel3PathwayToStorage(pathway, storage = globalThis?.localStorage) {
  const normalized = normalizeLevel3Pathway(pathway);
  try {
    storage?.setItem(LEVEL3_PATHWAY_STORAGE_KEY, normalized);
  } catch {
    // Storage can be unavailable in private contexts; keep the in-memory selection valid.
  }
  try {
    globalThis?.dispatchEvent?.(new CustomEvent(LEVEL3_PATHWAY_EVENT, { detail: { pathway: normalized } }));
  } catch {
    // Non-browser runtimes do not need cross-component pathway events.
  }
  return normalized;
}
