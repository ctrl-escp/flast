import {parentPort} from 'node:worker_threads';
import {Arborist, ModifierRunLimitError} from '../arborist.js';

/**
 * Reconstruct a modifier from source and run it against a deserialized snapshot.
 *
 * Workers cannot receive function objects. The main thread therefore sends
 * `Function.prototype.toString.call(modifier)` and this isolate rebuilds the
 * function with `(0, eval)(\`(${modifierSource})\`)`:
 *
 * - `Function.prototype.toString` is the only structured-cloneable view of
 *   the modifier. Closures, closed-over tables, and other captured bindings
 *   are not included. Put constants inside the function or read them from
 *   the AST.
 * - `(0, eval)` is indirect eval: it runs in the worker global scope, not in
 *   this module's local scope (`parentPort`, `snapshot`, `Arborist`). Direct
 *   `eval(modifierSource)` would also inherit those locals.
 * - The extra parentheses force `toString` output of a declaration or
 *   expression to parse as an expression so `eval` returns the function.
 * - This evaluates caller-supplied source in a Node isolate. It is not a
 *   sandbox.
 *
 * Marks are posted as they queue (`_onMark`) so the main Arborist can mirror
 * `{nodeId, replacement}` before `terminate()`. Replacements must be
 * structured-cloneable. Isolation of an invalid queue, when requested, runs
 * on the main thread after this worker stops.
 *
 * @example
 * // Main thread
 * worker.postMessage({
 *   snapshot: arborist.serialize(),
 *   modifierSource: Function.prototype.toString.call(replaceLiterals),
 *   maxMarkedNodes: 50,
 * });
 */
parentPort.on('message', ({snapshot, modifierSource, maxMarkedNodes}) => {
  try {
    const arborist = Arborist.deserialize(snapshot);
    if (maxMarkedNodes !== undefined) {
      arborist._maxMarkedNodes = maxMarkedNodes;
      arborist._markedNodesCount = 0;
    }
    arborist._onMark = (nodeId, replacement) => {
      parentPort.postMessage({type: 'mark', nodeId, replacement});
    };
    const modifier = (0, eval)(`(${modifierSource})`);
    const result = modifier(arborist);
    const replaced = result !== arborist;
    let resultSnapshot = snapshot;
    if (replaced) {
      resultSnapshot = result && typeof result.serialize === 'function' ?
        result.serialize() : arborist.serialize();
    }
    parentPort.postMessage({type: 'done', snapshot: resultSnapshot, replaced});
  } catch (error) {
    if (error instanceof ModifierRunLimitError) {
      parentPort.postMessage({type: 'limit'});
      return;
    }
    parentPort.postMessage({
      type: 'error',
      message: String(error),
      stack: error?.stack,
    });
  }
});
