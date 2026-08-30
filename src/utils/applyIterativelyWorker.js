import {parentPort} from 'node:worker_threads';
import {Arborist, ModifierRunLimitError} from '../arborist.js';

/**
 * Reconstruct a modifier from source and run it against a deserialized snapshot.
 *
 * Marks are posted as they queue so the main Arborist can mirror them before a
 * timeout terminates this isolate.
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
