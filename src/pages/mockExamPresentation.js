/**
 * Small, testable copy contracts for the CFA mock assessment chrome.
 * Keeping these strings together prevents the item and response-unit
 * denominators from looking like competing progress measures.
 */
export function getMockExamProgress({ answered, totalResponses, currentItem, totalItems }) {
  const safeTotalResponses = Math.max(0, Number(totalResponses) || 0);
  const safeTotalItems = Math.max(0, Number(totalItems) || 0);
  const safeCurrentItem = safeTotalItems ? Math.min(Math.max(1, Number(currentItem) || 1), safeTotalItems) : 0;
  const progressPct = safeTotalItems ? Math.round((safeCurrentItem / safeTotalItems) * 100) : 0;

  return {
    answered: `${Math.max(0, Number(answered) || 0)}/${safeTotalResponses}`,
    answeredDetail: `${safeTotalResponses} response units in this section`,
    item: `${safeCurrentItem}/${safeTotalItems}`,
    itemDetail: 'Current section item',
    progress: `${progressPct}%`,
    progressDetail: `${safeCurrentItem}/${safeTotalItems} section items`,
    railDetail: `${safeCurrentItem}/${safeTotalItems} items · ${Math.max(0, Number(answered) || 0)}/${safeTotalResponses} responses`,
  };
}

export function getFinishSectionHint(answered) {
  return Number(answered) > 0 ? '' : 'Answer at least one item to enable Finish Section.';
}
