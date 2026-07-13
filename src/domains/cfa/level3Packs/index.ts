import { buildLevel3Pack } from './factory';
import { level3TopicSpecs } from './topics';

export const level3AuthoredContentPacks = level3TopicSpecs.map(buildLevel3Pack);

export const level3TopicIds = level3TopicSpecs.map((topic) => topic.id);
