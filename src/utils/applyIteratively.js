import {Arborist} from '../arborist.js';
import {logger} from './logger.js';
import {shouldUseNextMajorDefaults} from './nextMajorDefaults.js';

/**
 * @typedef {object} ApplyIterativelyOptions
 * @property {number} [maxIterations=500] Maximum complete passes.
 * @property {'batch'|'sequential'} [mode='sequential'] Rebuild strategy.
 * @property {import('../types.d.ts').GenerateFlatASTOptions} [arboristOptions] Initial Arborist options.
 * @property {boolean} [nextMajorDefaults] Test the planned breaking defaults.
 */

const defaultMaxIterations = 500;
const iterativeModes = new Set(['batch', 'sequential']);

/**
 * Error raised when batch semantics cannot preserve queued mutations.
 *
 * A dedicated error class lets the outer compatibility wrapper continue to
 * handle ordinary modifier failures while ensuring this unsafe case is fatal.
 */
class BatchCompatibilityError extends Error {
  /**
   * Create an actionable batch-mode compatibility error.
   *
   * @example
   * throw new BatchCompatibilityError('replaceArborist');
   *
   * @param {string} modifierName Modifier that returned a replacement Arborist.
   */
  constructor(modifierName) {
    super(`Modifier "${modifierName}" returned a different Arborist while changes were pending. ` +
      'Use mode: \'sequential\' when modifiers replace the Arborist or depend on earlier rebuilt output.');
    this.name = 'BatchCompatibilityError';
  }
}

/**
 * Normalize the backward-compatible numeric limit and the options overload.
 *
 * @example
 * normalizeApplyOptions(3); // {maxIterations: 3, mode: 'sequential', arboristOptions: {}}
 *
 * @example
 * normalizeApplyOptions({mode: 'batch', maxIterations: 10});
 *
 * @param {number|ApplyIterativelyOptions|undefined} value Third applyIteratively argument.
 * @return {Required<Pick<ApplyIterativelyOptions, 'maxIterations'|'mode'>> & {arboristOptions: object}} Normalized options.
 */
function normalizeApplyOptions(value) {
  const options = typeof value === 'number' || value === undefined ?
    {maxIterations: value ?? defaultMaxIterations} : value;
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('applyIteratively options must be a number or an options object.');
  }
  const maxIterations = options.maxIterations ?? defaultMaxIterations;
  const useNextMajorDefaults = shouldUseNextMajorDefaults(options.nextMajorDefaults);
  const mode = options.mode ?? (useNextMajorDefaults ? 'batch' : 'sequential');
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 0) {
    throw new RangeError('maxIterations must be a non-negative safe integer.');
  }
  if (!iterativeModes.has(mode)) {
    throw new RangeError(`Unknown applyIteratively mode "${mode}". Expected "batch" or "sequential".`);
  }
  if (options.arboristOptions !== undefined &&
    (!options.arboristOptions || typeof options.arboristOptions !== 'object' ||
      Array.isArray(options.arboristOptions))) {
    throw new TypeError('arboristOptions must be an object.');
  }
  const arboristDefaults = useNextMajorDefaults ? {compactScopes: true, retainTokens: false} :
    options.nextMajorDefaults === false ? {nextMajorDefaults: false} : null;
  return {
    maxIterations,
    mode,
    arboristOptions: {...arboristDefaults, ...options.arboristOptions},
  };
}

/**
 * Report whether constructing a message for one logger level is worthwhile.
 *
 * @example
 * logger.setLogLevelNone();
 * isLogEnabled(logger.logLevels.DEBUG); // false
 *
 * @param {number} level Logger severity.
 * @return {boolean} Whether the shared logger would emit that severity.
 */
function isLogEnabled(level) {
  return level >= logger.currentLogLevel;
}

/**
 * Run one modifier while preserving ordinary-error compatibility.
 *
 * A modifier that throws may already have queued valid changes. The same
 * Arborist is therefore returned so later modifiers or the batch commit can
 * still apply that queue, matching the existing behavior.
 *
 * @example
 * runModifier(arborist, () => {
 *   arborist.replaceNode(target, replacement);
 *   throw new Error('optional cleanup failed');
 * }, 0); // Returns arborist with its replacement still queued.
 *
 * @param {Arborist} arborist Current mutation session.
 * @param {(arborist: Arborist) => Arborist} modifier Modifier to execute.
 * @param {number} iteration Zero-based iteration index.
 * @return {Arborist} Returned Arborist, or the current one after an ordinary error.
 */
function runModifier(arborist, modifier, iteration) {
  const debugEnabled = isLogEnabled(logger.logLevels.DEBUG);
  const errorEnabled = isLogEnabled(logger.logLevels.ERROR);
  const modifierName = modifier.name || '<anonymous>';
  const startTime = debugEnabled ? Date.now() : 0;
  try {
    if (debugEnabled) logger.debug(`\t[!] Running ${modifierName}...`);
    const result = modifier(arborist);
    if (!result || typeof result.getNumberOfChanges !== 'function' || !Array.isArray(result.ast)) {
      throw new TypeError(`Modifier "${modifierName}" must return an Arborist.`);
    }
    return result;
  } catch (error) {
    if (error instanceof BatchCompatibilityError) throw error;
    if (errorEnabled) {
      logger.error(`[-] Error in ${modifierName} (iteration #${iteration + 1}): ${error}\n${error.stack}`);
    }
    return arborist;
  } finally {
    if (debugEnabled) {
      logger.debug(`\t\t[!] Running ${modifierName} completed in ` +
        `${((Date.now() - startTime) / 1000).toFixed(3)} seconds`);
    }
  }
}

/**
 * Apply modifiers repeatedly until one complete pass leaves source unchanged.
 *
 * Sequential mode preserves same-pass visibility by rebuilding after each
 * modifier. Batch mode lets independent modifiers share one AST and performs
 * at most one rebuild per iteration.
 *
 * @example
 * const replaceOne = arborist => {
 *   const literal = arborist.ast[0].typeMap.Literal.find(node => node.value === 1);
 *   if (literal) arborist.replaceNode(literal, {type: 'Literal', value: 2});
 *   return arborist;
 * };
 * applyIteratively('const value = 1;', [replaceOne]); // 'const value = 2;'
 *
 * @example
 * applyIteratively(source, [renameA, replaceLiteral], {
 *   mode: 'batch',
 *   maxIterations: 10,
 *   arboristOptions: {compactScopes: true, retainTokens: false},
 * });
 *
 * @param {string} script Target source.
 * @param {Array<(arborist: Arborist) => Arborist>} funcs Ordered modifier functions.
 * @param {number|ApplyIterativelyOptions} [maxIterationsOrOptions=500] Numeric legacy limit or options.
 * @return {string} Possibly modified source.
 */
function applyIteratively(script, funcs, maxIterationsOrOptions = defaultMaxIterations) {
  const {maxIterations, mode, arboristOptions} = normalizeApplyOptions(maxIterationsOrOptions);
  if (maxIterations === 0) return script;

  let iteration = 0;
  try {
    let arborist = new Arborist(script, arboristOptions);
    while (arborist.ast?.length && iteration < maxIterations) {
      const iterationSource = arborist.script;
      const logEnabled = isLogEnabled(logger.logLevels.LOG);
      const iterationStartTime = logEnabled ? Date.now() : 0;
      let changesCounter = 0;

      for (let i = 0; i < funcs.length; i++) {
        const modifier = funcs[i];
        const previousArborist = arborist;
        const pendingBefore = previousArborist.getNumberOfChanges();
        const nextArborist = runModifier(previousArborist, modifier, iteration);
        const wasReplaced = nextArborist !== previousArborist;

        if (mode === 'batch' && wasReplaced && previousArborist.getNumberOfChanges() > 0) {
          // Switching instances would orphan mutations queued by this or an
          // earlier modifier, so batch mode must never guess which tree wins.
          throw new BatchCompatibilityError(modifier.name || '<anonymous>');
        }
        arborist = nextArborist;
        if (!arborist.ast?.length) break;

        if (mode === 'sequential') {
          const queuedChanges = arborist.getNumberOfChanges();
          if (queuedChanges) {
            changesCounter += arborist.applyChanges();
          } else if (wasReplaced && arborist.script !== previousArborist.script) {
            changesCounter++;
          }
        } else if (wasReplaced && pendingBefore === 0 && arborist.script !== previousArborist.script) {
          changesCounter++;
        }
      }

      if (mode === 'batch' && arborist.ast?.length) {
        const queuedChanges = arborist.getNumberOfChanges();
        if (queuedChanges) changesCounter += arborist.applyChanges();
      }

      script = arborist.script;
      iteration++;
      if (logEnabled) {
        logger.log(`[+] ==> Iteration #${iteration} completed in ${(Date.now() - iterationStartTime) / 1000} seconds` +
          ` with ${changesCounter || 'no'} changes (${arborist.ast?.length || '???'} nodes)`);
      }
      // Generated source is the authoritative convergence signal. A rejected
      // edit or a same-source replacement Arborist should stop immediately.
      if (script === iterationSource) break;
    }
  } catch (error) {
    if (error instanceof BatchCompatibilityError) throw error;
    if (isLogEnabled(logger.logLevels.ERROR)) {
      logger.error(`[-] Error on iteration #${iteration + 1}: ${error}\n${error.stack}`);
    }
  }
  return script;
}

export {applyIteratively};
