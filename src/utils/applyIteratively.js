import {Arborist, ModifierRunLimitError} from '../arborist.js';
import {logger} from './logger.js';
import {shouldUseNextMajorDefaults} from './nextMajorDefaults.js';

/**
 * @typedef {object} ApplyIterativelyOptions
 * @property {number} [maxIterations=500] Maximum complete passes.
 * @property {number} [currentIteration] Zero-based completed-iteration offset for logs and the remaining maxIterations budget.
 * @property {number} [maxMarkedNodes] Default mark cap for modifiers that omit `fn.maxMarkedNodes`.
 * @property {'batch'|'sequential'} [mode='sequential'] Rebuild strategy.
 * @property {import('../types.d.ts').GenerateFlatASTOptions} [arboristOptions] Initial Arborist options.
 * @property {boolean} [nextMajorDefaults] Test the planned breaking defaults.
 *
 * In the next major version the third argument becomes options-only, a module-level
 * iteration counter replaces `currentIteration`, `{resetIterationsCounter: true}`
 * reprints a call from 0 without zeroing that counter, and
 * `applyIteratively.resetIterationsCounter()` resets the module counter.
 */

const defaultMaxIterations = 500;
const iterativeModes = new Set(['batch', 'sequential']);
const applyIterativelyWorkerUrl = new URL('./applyIterativelyWorker.js', import.meta.url);

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
 * Require a positive safe integer for modifier run limits.
 *
 * @param {number} value Candidate limit.
 * @param {string} name Option or attribute name.
 * @return {number} The same value.
 */
function requirePositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer.`);
  }
  return value;
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
 * @return {Required<Pick<ApplyIterativelyOptions, 'maxIterations'|'mode'>> & {currentIteration: number, maxMarkedNodes: number|undefined, arboristOptions: object}} Normalized options.
 */
function normalizeApplyOptions(value) {
  const options = typeof value === 'number' || value === undefined ?
    {maxIterations: value ?? defaultMaxIterations} : value;
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('applyIteratively options must be a number or an options object.');
  }
  const maxIterations = options.maxIterations ?? defaultMaxIterations;
  const currentIteration = options.currentIteration || 0;
  const maxMarkedNodes = options.maxMarkedNodes === undefined ?
    undefined : requirePositiveSafeInteger(options.maxMarkedNodes, 'maxMarkedNodes');
  const useNextMajorDefaults = shouldUseNextMajorDefaults(options.nextMajorDefaults);
  const mode = options.mode ?? (useNextMajorDefaults ? 'batch' : 'sequential');
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 0) {
    throw new RangeError('maxIterations must be a non-negative safe integer.');
  }
  if (options.currentIteration !== undefined &&
    (!Number.isSafeInteger(options.currentIteration) || options.currentIteration < 0)) {
    throw new RangeError('currentIteration must be a non-negative safe integer.');
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
    currentIteration,
    maxMarkedNodes,
    mode,
    arboristOptions: {...arboristDefaults, ...options.arboristOptions},
  };
}

/**
 * Resolve the mark cap for one modifier, preferring the function attribute.
 *
 * @param {{maxMarkedNodes?: number}} modifier Modifier that may set a cap.
 * @param {number|undefined} defaultMaxMarkedNodes Options-level default.
 * @return {number|undefined} Cap to arm, if any.
 */
function resolveMaxMarkedNodes(modifier, defaultMaxMarkedNodes) {
  const value = modifier.maxMarkedNodes ?? defaultMaxMarkedNodes;
  return value === undefined ? undefined : requirePositiveSafeInteger(value, 'maxMarkedNodes');
}

/**
 * Resolve a per-modifier wall-clock budget.
 *
 * @param {{maxRunTimeMs?: number}} modifier Modifier that may set a timeout.
 * @return {number|undefined} Timeout in milliseconds, if any.
 */
function resolveMaxRunTimeMs(modifier) {
  return modifier.maxRunTimeMs === undefined ?
    undefined : requirePositiveSafeInteger(modifier.maxRunTimeMs, 'maxRunTimeMs');
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
 * Arm or clear the per-invocation mark cap on an Arborist.
 *
 * @param {Arborist} arborist Current mutation session.
 * @param {number|undefined} maxMarkedNodes Cap to arm, or undefined to clear.
 * @return {void}
 */
function setMarkLimit(arborist, maxMarkedNodes) {
  if (maxMarkedNodes === undefined) {
    delete arborist._maxMarkedNodes;
    delete arborist._markedNodesCount;
    return;
  }
  arborist._maxMarkedNodes = maxMarkedNodes;
  arborist._markedNodesCount = 0;
}

/**
 * Run one modifier while preserving ordinary-error compatibility.
 *
 * A modifier that throws may already have queued valid changes. The same
 * Arborist is therefore returned so later modifiers or the batch commit can
 * still apply that queue, matching the existing behavior. A mark-cap stop is
 * not logged as a failure.
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
 * @param {number|undefined} defaultMaxMarkedNodes Options-level mark cap.
 * @return {Arborist} Returned Arborist, or the current one after an ordinary error or mark-cap stop.
 */
function runModifier(arborist, modifier, iteration, defaultMaxMarkedNodes) {
  const debugEnabled = isLogEnabled(logger.logLevels.DEBUG);
  const errorEnabled = isLogEnabled(logger.logLevels.ERROR);
  const modifierName = modifier.name || '<anonymous>';
  const startTime = debugEnabled ? Date.now() : 0;
  const maxMarkedNodes = resolveMaxMarkedNodes(modifier, defaultMaxMarkedNodes);
  setMarkLimit(arborist, maxMarkedNodes);
  try {
    if (debugEnabled) logger.debug(`\t[!] Running ${modifierName}...`);
    const result = modifier(arborist);
    if (!result || typeof result.getNumberOfChanges !== 'function' || !Array.isArray(result.ast)) {
      throw new TypeError(`Modifier "${modifierName}" must return an Arborist.`);
    }
    return result;
  } catch (error) {
    if (error instanceof BatchCompatibilityError) throw error;
    if (error instanceof ModifierRunLimitError) return arborist;
    if (errorEnabled) {
      logger.error(`[-] Error in ${modifierName} (iteration #${iteration + 1}): ${error}\n${error.stack}`);
    }
    return arborist;
  } finally {
    setMarkLimit(arborist, undefined);
    if (debugEnabled) {
      logger.debug(`\t\t[!] Running ${modifierName} completed in ` +
        `${((Date.now() - startTime) / 1000).toFixed(3)} seconds`);
    }
  }
}

/**
 * Apply one modifier's result to the sequential or batch pass.
 *
 * @param {'batch'|'sequential'} mode Rebuild strategy.
 * @param {Arborist} previousArborist Session before this modifier.
 * @param {Arborist} nextArborist Session returned by the modifier.
 * @param {number} pendingBefore Queued-change count before the modifier ran.
 * @param {string} modifierName Name used in batch-compatibility errors.
 * @return {{arborist: Arborist, changes: number, empty: boolean}} Updated session and change delta.
 */
function applyModifierOutcome(mode, previousArborist, nextArborist, pendingBefore, modifierName) {
  const wasReplaced = nextArborist !== previousArborist;
  if (mode === 'batch' && wasReplaced && previousArborist.getNumberOfChanges() > 0) {
    throw new BatchCompatibilityError(modifierName);
  }
  if (!nextArborist.ast?.length) return {arborist: nextArborist, changes: 0, empty: true};
  let changes = 0;
  if (mode === 'sequential') {
    const queuedChanges = nextArborist.getNumberOfChanges();
    if (queuedChanges) changes += nextArborist.applyChanges();
    else if (wasReplaced && nextArborist.script !== previousArborist.script) changes++;
  } else if (wasReplaced && pendingBefore === 0 && nextArborist.script !== previousArborist.script) {
    changes++;
  }
  return {arborist: nextArborist, changes, empty: false};
}

/**
 * Commit a batch pass if the tree is still present and has queued edits.
 *
 * @param {'batch'|'sequential'} mode Rebuild strategy.
 * @param {Arborist} arborist Current session.
 * @return {number} Changes applied by the batch commit.
 */
function commitBatchIfNeeded(mode, arborist) {
  if (mode === 'batch' && arborist.ast?.length) {
    const queuedChanges = arborist.getNumberOfChanges();
    if (queuedChanges) return arborist.applyChanges();
  }
  return 0;
}

/**
 * Log a completed iteration when the shared logger is at LOG or lower.
 *
 * @param {number} iteration One-based completed iteration number.
 * @param {number} iterationStartTime Epoch ms when the pass started.
 * @param {number} changesCounter Applied changes in this pass.
 * @param {Arborist} arborist Session after the pass.
 * @return {void}
 */
function logIterationComplete(iteration, iterationStartTime, changesCounter, arborist) {
  if (!isLogEnabled(logger.logLevels.LOG)) return;
  logger.log(`[+] ==> Iteration #${iteration} completed in ${(Date.now() - iterationStartTime) / 1000} seconds` +
    ` with ${changesCounter || 'no'} changes (${arborist.ast?.length || '???'} nodes)`);
}

/**
 * Run one modifier in a worker until it finishes, hits the mark cap, or times out.
 *
 * @param {Arborist} arborist Main-thread session that receives mirrored marks.
 * @param {(arborist: Arborist) => Arborist} modifier Modifier to reconstruct in the worker.
 * @param {number} iteration Zero-based iteration index.
 * @param {number|undefined} defaultMaxMarkedNodes Options-level mark cap.
 * @param {number} maxRunTimeMs Wall-clock budget for this invocation.
 * @return {Promise<Arborist>} The original session, or a deserialized replacement.
 */
async function runModifierInWorker(arborist, modifier, iteration, defaultMaxMarkedNodes, maxRunTimeMs) {
  const {Worker} = await import('node:worker_threads');
  const modifierName = modifier.name || '<anonymous>';
  const maxMarkedNodes = resolveMaxMarkedNodes(modifier, defaultMaxMarkedNodes);
  return new Promise(resolve => {
    const worker = new Worker(applyIterativelyWorkerUrl, {type: 'module'});
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish(arborist), maxRunTimeMs);
    worker.on('message', message => {
      if (message.type === 'mark') {
        const node = arborist.ast[message.nodeId];
        if (node) arborist.markNode(node, message.replacement);
        return;
      }
      if (message.type === 'done') {
        finish(message.replaced ? Arborist.deserialize(message.snapshot) : arborist);
        return;
      }
      if (message.type === 'limit') {
        finish(arborist);
        return;
      }
      if (message.type === 'error') {
        if (isLogEnabled(logger.logLevels.ERROR)) {
          logger.error(`[-] Error in ${modifierName} (iteration #${iteration + 1}): ${message.message}\n${message.stack}`);
        }
        finish(arborist);
      }
    });
    worker.on('error', error => {
      if (isLogEnabled(logger.logLevels.ERROR)) {
        logger.error(`[-] Error in ${modifierName} (iteration #${iteration + 1}): ${error}\n${error.stack}`);
      }
      finish(arborist);
    });
    worker.postMessage({
      snapshot: arborist.serialize(),
      modifierSource: Function.prototype.toString.call(modifier),
      maxMarkedNodes,
    });
  });
}

/**
 * Apply modifiers repeatedly until one complete pass leaves source unchanged.
 *
 * Sequential mode preserves same-pass visibility by rebuilding after each
 * modifier. Batch mode lets independent modifiers share one AST and performs
 * at most one rebuild per iteration.
 *
 * Optional `fn.maxMarkedNodes` (or `{maxMarkedNodes}`) stops a modifier on the
 * mark that would exceed the cap and keeps the same Arborist so queued marks
 * still apply. `maxRunTimeMs` is ignored here; use {@link applyIterativelyAsync}.
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
 * @example
 * applyIteratively(source, [stageB], {currentIteration: 7, maxIterations: 20});
 *
 * The next major version will drop the numeric third argument, drop
 * `currentIteration`, keep a module-level iteration total, accept
 * `{resetIterationsCounter: true}` to reprint a call from 0, and expose
 * `applyIteratively.resetIterationsCounter()` to zero that total.
 *
 * @param {string} script Target source.
 * @param {Array<(arborist: Arborist) => Arborist>} funcs Ordered modifier functions.
 * @param {number|ApplyIterativelyOptions} [maxIterationsOrOptions=500] Numeric legacy limit or options.
 * @return {string} Possibly modified source.
 */
function applyIteratively(script, funcs, maxIterationsOrOptions = defaultMaxIterations) {
  const {maxIterations, currentIteration, maxMarkedNodes, mode, arboristOptions} =
    normalizeApplyOptions(maxIterationsOrOptions);
  if (maxIterations === 0) return script;

  let iteration = currentIteration || 0;
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
        const nextArborist = runModifier(previousArborist, modifier, iteration, maxMarkedNodes);
        const outcome = applyModifierOutcome(
          mode, previousArborist, nextArborist, pendingBefore, modifier.name || '<anonymous>');
        arborist = outcome.arborist;
        changesCounter += outcome.changes;
        if (outcome.empty) break;
      }

      changesCounter += commitBatchIfNeeded(mode, arborist);
      script = arborist.script;
      iteration++;
      logIterationComplete(iteration, iterationStartTime, changesCounter, arborist);
      if (script === iterationSource) break;
    }
  } catch (error) {
    if (error instanceof BatchCompatibilityError || error instanceof RangeError) throw error;
    if (isLogEnabled(logger.logLevels.ERROR)) {
      logger.error(`[-] Error on iteration #${iteration + 1}: ${error}\n${error.stack}`);
    }
  }
  return script;
}

/**
 * Async counterpart of {@link applyIteratively} with an optional worker timeout.
 *
 * Same arguments and mark-cap behavior. When `fn.maxRunTimeMs` is set, that
 * invocation runs in a `worker_threads` isolate. flAST mirrors `nodeId` marks
 * onto the original Arborist; `terminate()` stops the isolate after the budget.
 *
 * @example
 * replaceLiterals.maxRunTimeMs = 1000;
 * const result = await applyIterativelyAsync(source, [replaceLiterals]);
 *
 * @param {string} script Target source.
 * @param {Array<(arborist: Arborist) => Arborist>} funcs Ordered modifier functions.
 * @param {number|ApplyIterativelyOptions} [maxIterationsOrOptions=500] Numeric legacy limit or options.
 * @return {Promise<string>} Possibly modified source.
 */
async function applyIterativelyAsync(script, funcs, maxIterationsOrOptions = defaultMaxIterations) {
  const {maxIterations, currentIteration, maxMarkedNodes, mode, arboristOptions} =
    normalizeApplyOptions(maxIterationsOrOptions);
  if (maxIterations === 0) return script;

  let iteration = currentIteration || 0;
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
        const maxRunTimeMs = resolveMaxRunTimeMs(modifier);
        const nextArborist = maxRunTimeMs ?
          await runModifierInWorker(previousArborist, modifier, iteration, maxMarkedNodes, maxRunTimeMs) :
          runModifier(previousArborist, modifier, iteration, maxMarkedNodes);
        const outcome = applyModifierOutcome(
          mode, previousArborist, nextArborist, pendingBefore, modifier.name || '<anonymous>');
        arborist = outcome.arborist;
        changesCounter += outcome.changes;
        if (outcome.empty) break;
      }

      changesCounter += commitBatchIfNeeded(mode, arborist);
      script = arborist.script;
      iteration++;
      logIterationComplete(iteration, iterationStartTime, changesCounter, arborist);
      if (script === iterationSource) break;
    }
  } catch (error) {
    if (error instanceof BatchCompatibilityError || error instanceof RangeError) throw error;
    if (isLogEnabled(logger.logLevels.ERROR)) {
      logger.error(`[-] Error on iteration #${iteration + 1}: ${error}\n${error.stack}`);
    }
  }
  return script;
}

export {applyIteratively, applyIterativelyAsync};
