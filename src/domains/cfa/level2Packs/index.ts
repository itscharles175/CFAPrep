import { buildLevel2Pack } from './factory';
import { level2TopicSpecs } from './topics';

export const level2AuthoredContentPacks = level2TopicSpecs.map(buildLevel2Pack);

export const level2TopicIds = level2TopicSpecs.map((topic) => topic.id);
