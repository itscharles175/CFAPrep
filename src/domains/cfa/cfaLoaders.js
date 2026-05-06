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

export async function loadCfaLevelContent(level = 'level1') {
  const module = await loadRuntimeModule(level);
  return module.getCfaLevelContent();
}

export async function loadCfaTopicContent(level = 'level1', topicId) {
  const module = await loadRuntimeModule(level);
  return module.getCfaTopicContent(topicId);
}

export async function loadCfaMockExam(level = 'level1', mockId) {
  const module = await loadRuntimeModule(level);
  return module.getCfaMockExam(mockId);
}

export async function loadCfaRuntimeReport() {
  const module = await import('./cfaSummary');
  return module.getCfaRuntimeReport();
}
