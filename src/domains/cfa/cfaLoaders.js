export function getCfaTopicKey(level = 'level1', topic) {
  return level === 'level1' ? topic : `${level}:${topic}`;
}

const levelLoaders = {
  level1: () => import('./cfaLevel1Runtime'),
  level2: () => import('./cfaLevel2Runtime'),
  level3: () => import('./cfaLevel3Runtime'),
};

async function loadRuntimeModule(level = 'level1') {
  return (levelLoaders[level] || levelLoaders.level1)();
}

export async function loadCfaLevelContent(level = 'level1', options = {}) {
  const module = await loadRuntimeModule(level);
  return module.getCfaLevelContent(options);
}

export async function loadCfaTopicContent(level = 'level1', topicId, options = {}) {
  const module = await loadRuntimeModule(level);
  return module.getCfaTopicContent(topicId, options);
}

export async function loadCfaMockExam(level = 'level1', mockId, options = {}) {
  const module = await loadRuntimeModule(level);
  if (level === 'level3' && options.pathway && module.getCfaMockExamForPathway) {
    return module.getCfaMockExamForPathway(options.pathway, mockId);
  }
  return module.getCfaMockExam(mockId);
}

export async function loadCfaRuntimeReport() {
  const module = await import('./cfaSummary');
  return module.getCfaRuntimeReport();
}
