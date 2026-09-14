// Presentation contract for the CFA assessment action rail. Kept outside the
// component module so Vite fast refresh can treat CfaQuiz as a component-only
// module while tests can verify that the action remains in document flow.
export const CFA_QUIZ_ACTION_STYLE = Object.freeze({
  position: 'static',
  zIndex: 'auto',
  padding: '0',
  background: 'transparent',
});
