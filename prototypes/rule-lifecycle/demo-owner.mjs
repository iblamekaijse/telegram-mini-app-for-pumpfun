// Local trusted bootstrap ONLY. This is not a login, signature or remote authorization.
const contexts = new WeakMap();

export function createTrustedDemoOwnerContext({ ruleIds, principalId = 'DEMO:owner' }) {
  if (!Array.isArray(ruleIds) || !ruleIds.length || !ruleIds.every(id => typeof id === 'string' && id.length > 0) ||
    typeof principalId !== 'string' || !principalId.startsWith('DEMO:')) throw new TypeError('Invalid demo owner grant');
  const context = Object.freeze({ mode: 'trusted-local-demo-owner' });
  contexts.set(context, { ruleIds: new Set(ruleIds), principalId });
  return context;
}

export function authorizedDemoPrincipal(context, ruleId) {
  const grant = contexts.get(context);
  return grant?.ruleIds.has(ruleId) ? grant.principalId : null;
}
