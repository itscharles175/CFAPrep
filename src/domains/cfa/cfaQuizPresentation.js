// Presentation contract for the CFA assessment action rail. Kept outside the
// component module so Vite fast refresh can treat CfaQuiz as a component-only
// module while tests can still verify the local sticky action behavior.
export const CFA_QUIZ_ACTION_STYLE = Object.freeze({
  position: 'sticky',
  bottom: 'var(--space-4)',
  zIndex: 10,
  padding: 'var(--space-3) 0',
  background: 'linear-gradient(to bottom, transparent, var(--bg-primary) 32%)',
});
