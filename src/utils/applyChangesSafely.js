import {Arborist} from '../arborist.js';
import {generateCode, parseCode} from '../flast.js';
import {logger} from './logger.js';

/** @import {ASTNode, GenerateFlatASTOptions} from '../types.d.ts' */

/**
 * @typedef {object} QueuedChange
 * @property {'replace'|'delete'} type Queued mutation kind.
 * @property {number} nodeId Target index on the pre-apply tree.
 * @property {ASTNode} target Live node from the Arborist that queued the edit.
 * @property {ASTNode|object} [replacement] Replacement node when `type` is replace.
 */

/**
 * @typedef {object} RejectedChange
 * @property {'replace'|'delete'} type Queued mutation kind.
 * @property {number} nodeId Target index on the pre-apply tree.
 * @property {ASTNode} target Original node from the pre-apply tree.
 * @property {ASTNode|object} [replacement] Replacement node when `type` is replace.
 * @property {string} [error] Generate/parse message, interaction note, or skip reason.
 * @property {string} [modifier] Set by iterative wrappers for sequential commits.
 * @property {number} [iteration] Set by iterative wrappers (one-based pass number).
 */

/**
 * @typedef {object} ApplyChangesSafelyResult
 * @property {Arborist} arborist The same instance, with every valid edit applied.
 * @property {number} applied Count returned by the successful `applyChanges()` commit.
 * @property {RejectedChange[]} rejected Edits that could not be kept.
 */

const rootExclusiveError = 'Skipped because a root replacement replaces the entire program';
const interactionError = 'Change is valid alone but interacts with other accepted changes';
const invalidScriptError = 'Modified script is invalid';

/**
 * Run work with the shared logger silenced so isolation trials do not emit
 * one revert line per failed subset.
 *
 * @example
 * withSilentLogger(() => 1); // 1; logger threshold is restored
 *
 * @template T
 * @param {() => T} fn Work to run.
 * @return {T} The function result.
 */
function withSilentLogger(fn) {
  const previous = logger.currentLogLevel;
  logger.setLogLevelNone();
  try {
    return fn();
  } finally {
    logger.setLogLevel(previous);
  }
}

/**
 * Fill `arborist.script` when the session was built from an AST array.
 *
 * `serialize()` / `deserialize()` rebuild from the script string. An AST-only
 * Arborist stores `''` until the first apply, so isolation would have nothing
 * to parse.
 *
 * @example
 * const arborist = new Arborist(generateFlatAST('const value = 1;'));
 * ensureScript(arborist);
 * arborist.script; // 'const value = 1;'
 *
 * @param {Arborist} arborist Session that may lack generated source.
 * @return {void}
 */
function ensureScript(arborist) {
  if (arborist.script) return;
  const root = arborist.ast[0];
  if (!root) return;
  arborist.script = root.src || generateCode(root);
}

/**
 * Snapshot queued marks as reviewable change records.
 *
 * Deletions are listed first, then replacements, matching `applyChanges()`.
 * Each record keeps the live `target` so rejected items still expose `src`
 * and `type` after the Arborist rebuilds.
 *
 * @example
 * const arborist = new Arborist('const value = 1;');
 * arborist.replaceNode(arborist.ast.find(n => n.type === 'Literal'), {type: 'Literal', value: 2});
 * snapshotChanges(arborist)[0].type; // 'replace'
 *
 * @param {Arborist} arborist Session with a pending queue.
 * @return {QueuedChange[]} Ordered queued edits.
 */
function snapshotChanges(arborist) {
  const changes = [];
  for (let i = 0; i < arborist.markedForDeletion.length; i++) {
    const nodeId = arborist.markedForDeletion[i];
    const target = arborist.ast[nodeId];
    if (target) changes.push({type: 'delete', nodeId, target});
  }
  for (let i = 0; i < arborist.replacements.length; i++) {
    const [target, replacement] = arborist.replacements[i];
    changes.push({type: 'replace', nodeId: target.nodeId, target, replacement});
  }
  return changes;
}

/**
 * Options for a validity trial: skip metadata that does not affect parse.
 *
 * Node IDs stay stable because flatten order is independent of `detailed`,
 * `includeSrc`, and `retainTokens`. `parseOpts` and script `sourceType` are
 * kept so sloppy syntax such as `with` still parses.
 *
 * @example
 * leanTrialOptions({retainTokens: true}, 'script').retainTokens; // false
 * leanTrialOptions({}, 'script').parseOpts.sourceType; // 'script'
 *
 * @param {GenerateFlatASTOptions|undefined} options Original Arborist options.
 * @param {string|undefined} sourceType Program source type from the current root.
 * @return {GenerateFlatASTOptions} Options used only for trial deserializations.
 */
function leanTrialOptions(options, sourceType) {
  const parseOpts = {...options?.parseOpts};
  if (sourceType === 'script') parseOpts.sourceType = 'script';
  return {
    ...options,
    detailed: false,
    includeSrc: false,
    retainTokens: false,
    parseOpts,
  };
}

/**
 * Build a deserialize payload that re-marks only the given subset.
 *
 * Trials always start from this original snapshot. After a rebuild, old node
 * objects are stale; `nodeId` is stable for the same script and options, so
 * the AST is omitted on purpose.
 *
 * @example
 * const snapshot = makeTrialSnapshot(
 *   {script: 'const value = 1;', options: {}},
 *   'script',
 *   [{type: 'replace', nodeId: 4, target: {}, replacement: {type: 'Literal', value: 2}}],
 * );
 * snapshot.replacements[0][0]; // 4
 *
 * @param {{script: string, options?: GenerateFlatASTOptions}} baseSnapshot Original session snapshot.
 * @param {string|undefined} sourceType Program source type.
 * @param {QueuedChange[]} changes Subset to re-mark.
 * @return {import('../types.d.ts').ArboristSnapshot} Cloneable trial snapshot.
 */
function makeTrialSnapshot(baseSnapshot, sourceType, changes) {
  const replacements = [];
  const markedForDeletion = [];
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    if (change.type === 'delete') markedForDeletion.push(change.nodeId);
    else replacements.push([change.nodeId, change.replacement]);
  }
  return {
    script: baseSnapshot.script,
    options: leanTrialOptions(baseSnapshot.options, sourceType),
    replacements,
    markedForDeletion,
  };
}

/**
 * Convert a queued edit into the public rejected record.
 *
 * @example
 * toRejectedChange({type: 'delete', nodeId: 3, target: {type: 'Literal'}}, 'boom').error; // 'boom'
 *
 * @param {QueuedChange} change Queued edit.
 * @param {string} [error] Why the edit was dropped.
 * @return {RejectedChange} Reviewable rejected change.
 */
function toRejectedChange(change, error) {
  const rejected = {
    type: change.type,
    nodeId: change.nodeId,
    target: change.target,
  };
  if (change.type === 'replace') rejected.replacement = change.replacement;
  if (error) rejected.error = error;
  return rejected;
}

/**
 * Apply queued marks onto the live tree so `generateCode` can describe a failure.
 *
 * This is only used to recover an escodegen/Espree message after
 * `applyChanges()` has already reverted. It is not a second apply path.
 *
 * @example
 * const probe = Arborist.deserialize(snapshot);
 * applyMarksForGeneration(probe);
 * generateCode(probe.ast[0]);
 *
 * @param {Arborist} probe Deserialized session with the subset already marked.
 * @return {void}
 */
function applyMarksForGeneration(probe) {
  const root = probe.ast[0];
  if (root?.isMarked) {
    const replacement = probe.replacements.find(pair => pair[0].nodeId === 0)?.[1];
    if (replacement) probe.ast[0] = replacement;
    return;
  }
  for (let i = 0; i < probe.markedForDeletion.length; i++) {
    const target = probe.ast[probe.markedForDeletion[i]];
    if (!target?.parentNode) continue;
    const parent = target.parentNode;
    const key = target.parentKey;
    if (parent[key] === target) delete parent[key];
    else if (Array.isArray(parent[key])) {
      const idx = parent[key].indexOf(target);
      if (idx !== -1) parent[key].splice(idx, 1);
    }
  }
  for (let i = 0; i < probe.replacements.length; i++) {
    const [target, replacement] = probe.replacements[i];
    if (!target?.parentNode) continue;
    const parent = target.parentNode;
    const key = target.parentKey;
    if (parent[key] === target) parent[key] = replacement;
    else if (Array.isArray(parent[key])) {
      const idx = parent[key].indexOf(target);
      if (idx !== -1) parent[key][idx] = replacement;
    }
  }
}

/**
 * Recover a generate or parse message for a subset that already failed a trial.
 *
 * @example
 * describeSubsetFailure(
 *   {script: 'const value = 1;', options: {}},
 *   'script',
 *   [{type: 'replace', nodeId: 4, target: {}, replacement: {type: 'EmptyStatement'}}],
 * ); // Espree or escodegen message
 *
 * @param {{script: string, options?: GenerateFlatASTOptions}} baseSnapshot Original session snapshot.
 * @param {string|undefined} sourceType Program source type.
 * @param {QueuedChange[]} changes Failing subset.
 * @return {string} Best available error text.
 */
function describeSubsetFailure(baseSnapshot, sourceType, changes) {
  try {
    const probe = Arborist.deserialize(makeTrialSnapshot(baseSnapshot, sourceType, changes));
    applyMarksForGeneration(probe);
    const script = generateCode(probe.ast[0]);
    try {
      parseCode(script, {
        ...baseSnapshot.options?.parseOpts,
        sourceType: sourceType === 'module' ? 'module' : 'script',
      });
    } catch (error) {
      return error.message || String(error);
    }
    return invalidScriptError;
  } catch (error) {
    return error.message || String(error);
  }
}

/**
 * Test whether a subset generates and reparses.
 *
 * Always deserializes the original snapshot so trials never rematch a rebuilt
 * tree. `applyChanges()` is the same validator production uses.
 *
 * @example
 * trialApply({script: 'const value = 1;', options: {}}, 'script', []); // {ok: true}
 *
 * @param {{script: string, options?: GenerateFlatASTOptions}} baseSnapshot Original session snapshot.
 * @param {string|undefined} sourceType Program source type.
 * @param {QueuedChange[]} changes Subset to try.
 * @return {{ok: boolean, error?: string}} Whether the subset is valid.
 */
function trialApply(baseSnapshot, sourceType, changes) {
  if (!changes.length) return {ok: true};
  const probe = Arborist.deserialize(makeTrialSnapshot(baseSnapshot, sourceType, changes));
  if (probe.applyChanges() > 0) return {ok: true};
  return {ok: false, error: describeSubsetFailure(baseSnapshot, sourceType, changes)};
}

/**
 * Isolate a failing set into accepted edits and rejected records.
 *
 * 1. Try the group. Success keeps every member.
 * 2. A single failure is rejected with its generate/parse error.
 * 3. A larger failure is split in half and each half is isolated
 *    (`O(k log n)` trials for `k` independent bad edits).
 * 4. The union of accepted halves is tried once. If that fails, the halves
 *    interact: keep members in original order only while the growing prefix
 *    still parses.
 *
 * @example
 * // One invalid replace among three: two accepted, one rejected.
 * isolateChanges(snapshot, 'script', [validA, invalidB, validC]).rejected.length; // 1
 *
 * @param {{script: string, options?: GenerateFlatASTOptions}} baseSnapshot Original session snapshot.
 * @param {string|undefined} sourceType Program source type.
 * @param {QueuedChange[]} changes Group to isolate.
 * @return {{accepted: QueuedChange[], rejected: RejectedChange[]}} Partition.
 */
function isolateChanges(baseSnapshot, sourceType, changes) {
  if (!changes.length) return {accepted: [], rejected: []};
  const trial = trialApply(baseSnapshot, sourceType, changes);
  if (trial.ok) return {accepted: changes, rejected: []};
  if (changes.length === 1) {
    return {accepted: [], rejected: [toRejectedChange(changes[0], trial.error)]};
  }
  const mid = changes.length >> 1;
  const left = isolateChanges(baseSnapshot, sourceType, changes.slice(0, mid));
  const right = isolateChanges(baseSnapshot, sourceType, changes.slice(mid));
  const acceptedHalves = left.accepted.concat(right.accepted);
  const rejected = left.rejected.concat(right.rejected);
  if (!acceptedHalves.length) return {accepted: [], rejected};
  if (trialApply(baseSnapshot, sourceType, acceptedHalves).ok) {
    return {accepted: acceptedHalves, rejected};
  }
  const accepted = [];
  for (let i = 0; i < acceptedHalves.length; i++) {
    const change = acceptedHalves[i];
    if (trialApply(baseSnapshot, sourceType, accepted.concat([change])).ok) accepted.push(change);
    else rejected.push(toRejectedChange(change, interactionError));
  }
  return {accepted, rejected};
}

/**
 * Drop leftover marks so a later `replaceNode` / `deleteNode` is not ignored.
 *
 * @example
 * clearQueuedMarks(arborist);
 * arborist.getNumberOfChanges(); // 0
 *
 * @param {Arborist} arborist Session whose queue should be emptied.
 * @return {void}
 */
function clearQueuedMarks(arborist) {
  for (let i = 0; i < arborist.replacements.length; i++) {
    const target = arborist.replacements[i][0];
    if (target) {
      target.isMarked = false;
      target.isMarkedForDeletion = false;
    }
  }
  for (let i = 0; i < arborist.markedForDeletion.length; i++) {
    const node = arborist.ast[arborist.markedForDeletion[i]];
    if (node) {
      node.isMarked = false;
      node.isMarkedForDeletion = false;
    }
  }
  arborist.replacements.length = 0;
  arborist.markedForDeletion.length = 0;
}

/**
 * Queue accepted edits on the input Arborist by current `nodeId`.
 *
 * After a failed `applyChanges()` the tree may have been rebuilt, so the
 * original target objects must not be reused.
 *
 * @example
 * requeueAccepted(arborist, [{type: 'replace', nodeId: 4, target, replacement}]);
 *
 * @param {Arborist} arborist Session to re-mark.
 * @param {QueuedChange[]} accepted Edits that isolated as valid.
 * @return {void}
 */
function requeueAccepted(arborist, accepted) {
  clearQueuedMarks(arborist);
  for (let i = 0; i < accepted.length; i++) {
    const change = accepted[i];
    const node = arborist.ast[change.nodeId];
    if (!node) continue;
    if (change.type === 'delete') arborist.deleteNode(node);
    else arborist.replaceNode(node, change.replacement);
  }
}

/**
 * Apply every queued edit that still produces valid source.
 *
 * `applyChanges()` is atomic: one bad replacement or deletion reverts the
 * whole batch. This helper is the production commit when a modifier may queue
 * some invalid edits and the valid ones should still be kept.
 *
 * Fast path: snapshot the queue, then call `applyChanges()` on the input
 * instance. Queues are snapshotted first because `applyChanges()` clears them
 * even when it reverts. If that commit succeeds, isolation is skipped.
 *
 * Failed batches are isolated against the original `serialize()` snapshot so
 * trials never rematch a rebuilt tree. The input Arborist is updated only
 * for the final accepted commit. Isolation trials stay on the main thread.
 *
 * When the program root is marked, `applyChanges()` replaces the whole
 * program and ignores sibling marks. Those siblings are reported as rejected
 * so they are not mistaken for applied edits.
 *
 * @example
 * const arborist = new Arborist('const a = 1, b = 2;');
 * const literals = arborist.ast[0].typeMap.Literal;
 * arborist.replaceNode(literals[0], {type: 'Literal', value: 10});
 * arborist.replaceNode(literals[1], {type: 'EmptyStatement'});
 * const {applied, rejected} = applyChangesSafely(arborist);
 * arborist.script; // 'const a = 10, b = 2;'
 * applied; // 1
 * rejected[0].type; // 'replace'
 *
 * @example
 * applyChangesSafely(new Arborist('const value = 1;'));
 * // {applied: 0, rejected: []}
 *
 * @param {Arborist} arborist Session with a pending queue.
 * @return {ApplyChangesSafelyResult} The same Arborist plus rejected edits.
 */
function applyChangesSafely(arborist) {
  if (!arborist.getNumberOfChanges()) {
    return {arborist, applied: 0, rejected: []};
  }
  ensureScript(arborist);
  const changes = snapshotChanges(arborist);
  const rootIsMarked = Boolean(arborist.ast[0]?.isMarked);
  const effectiveChanges = rootIsMarked ? changes.filter(change => change.nodeId === 0) : changes;
  const unusedChanges = rootIsMarked ? changes.filter(change => change.nodeId !== 0) : [];
  const unusedRejected = unusedChanges.map(change => toRejectedChange(change, rootExclusiveError));
  const snapshot = arborist.serialize();
  const sourceType = arborist.ast[0]?.sourceType;
  const applied = arborist.applyChanges();
  if (applied > 0) {
    return {arborist, applied, rejected: unusedRejected};
  }
  const {accepted, rejected} = withSilentLogger(() => isolateChanges(snapshot, sourceType, effectiveChanges));
  if (!accepted.length) {
    clearQueuedMarks(arborist);
    return {arborist, applied: 0, rejected: rejected.concat(unusedRejected)};
  }
  requeueAccepted(arborist, accepted);
  return {
    arborist,
    applied: arborist.applyChanges(),
    rejected: rejected.concat(unusedRejected),
  };
}

export {applyChangesSafely};
