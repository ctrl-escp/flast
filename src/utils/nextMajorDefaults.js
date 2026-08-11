/**
 * Read the opt-in environment switch without requiring Node.js globals.
 *
 * Browser builds see no `process` object and therefore keep current defaults.
 *
 * @example
 * // FLAST_NEXT_MAJOR_DEFAULTS=1
 * environmentUsesNextMajorDefaults(); // true
 *
 * @return {boolean} Whether the environment enables the future defaults.
 */
function environmentUsesNextMajorDefaults() {
  const value = globalThis.process?.env?.FLAST_NEXT_MAJOR_DEFAULTS;
  return value === '1' || value?.toLowerCase() === 'true';
}

/**
 * Resolve a per-call override before consulting the environment.
 *
 * An explicit false is significant: it lets one operation retain current
 * behavior even when the process-wide test switch is enabled.
 *
 * @example
 * shouldUseNextMajorDefaults(true); // true
 * shouldUseNextMajorDefaults(false); // false, regardless of the environment
 *
 * @param {boolean|undefined} explicit Per-call override.
 * @return {boolean} Whether future defaults apply to this operation.
 */
function shouldUseNextMajorDefaults(explicit) {
  return explicit ?? environmentUsesNextMajorDefaults();
}

export {shouldUseNextMajorDefaults};
