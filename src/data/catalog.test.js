import { describe, expect, it } from 'vitest';
import { buildSearchItems, cfaTopics, excelModules, quantModules } from './catalog';
import { cfaContent, cfaLearningObjectives, cfaQuestionBank, cfaQuizzes } from '../domains/cfa/cfaData';
import { excelContent } from './excelContent';
import { quantContent } from './quantContent';
import { appRoutes, searchToolRoutes, smokeRoutes } from '../routes/routeManifest';

describe('learning catalog integrity', () => {
  it('has content for every available quant and excel module', () => {
    quantModules.filter((module) => module.status === 'available').forEach((module) => {
      expect(quantContent[module.id], module.id).toBeTruthy();
    });

    excelModules.filter((module) => module.status === 'available').forEach((module) => {
      expect(excelContent[module.id], module.id).toBeTruthy();
    });
  });

  it('has CFA content for every available CFA topic', () => {
    cfaTopics.filter((topic) => topic.status === 'available').forEach((topic) => {
      const content = cfaContent[topic.id];
      const objectives = cfaLearningObjectives[topic.id] || [];
      const quiz = cfaQuizzes[topic.id] || [];

      expect(content, topic.id).toBeTruthy();
      expect(content.sections?.length, `${topic.id} lessons`).toBeGreaterThan(0);
      expect(content.formulas?.length, `${topic.id} formulas`).toBeGreaterThan(0);
      expect(objectives.length, `${topic.id} objectives`).toBeGreaterThan(0);
      expect(quiz.length, `${topic.id} questions`).toBeGreaterThan(0);

      quiz.forEach((question) => {
        expect(question.learningObjective, question.id).toBeTruthy();
        expect(question.tags?.length, `${question.id} tags`).toBeGreaterThan(0);
        expect(question.errorCategories?.length, `${question.id} error categories`).toBeGreaterThan(0);
        expect(question.options.length, `${question.id} options`).toBeGreaterThanOrEqual(3);
        expect(question.correct, `${question.id} correct answer`).toBeGreaterThanOrEqual(0);
        expect(question.correct, `${question.id} correct answer`).toBeLessThan(question.options.length);
      });
    });
  });

  it('has a unique CFA question bank mapped to available topics', () => {
    const ids = new Set(cfaQuestionBank.map((question) => question.id));
    const availableTopicIds = new Set(cfaTopics.filter((topic) => topic.status === 'available').map((topic) => topic.id));

    expect(ids.size).toBe(cfaQuestionBank.length);
    expect(cfaQuestionBank.length).toBeGreaterThan(45);
    cfaQuestionBank.forEach((question) => {
      expect(availableTopicIds.has(question.topic), question.id).toBe(true);
    });
  });

  it('builds a useful search index with unique IDs', () => {
    const items = buildSearchItems();
    const ids = new Set(items.map((item) => item.id));
    expect(ids.size).toBe(items.length);
    expect(items.length).toBeGreaterThan(30);
    expect(items.some((item) => item.path === '/calculators')).toBe(true);
  });

  it('keeps route, search, and smoke metadata centralized', () => {
    const routeMatches = (routePath, actualPath) => {
      const pattern = new RegExp(`^${routePath.replace(/:[^/]+/g, '[^/]+')}$`);
      return pattern.test(actualPath);
    };
    expect(searchToolRoutes.every((route) => route.id.startsWith('tool:'))).toBe(true);
    smokeRoutes.forEach(([path]) => {
      expect(appRoutes.some((route) => routeMatches(route.path, path))).toBe(true);
    });
  });
});
