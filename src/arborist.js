import {logger} from './utils/logger.js';
import {generateCode, generateFlatAST} from './flast.js';

/** @import {ASTNode, GenerateFlatASTOptions} from './types.d.ts' */

const batchedMutationMinimum = 128;
const deletedArraySlot = Symbol('deletedArraySlot');
const scriptParseOptions = {
  alternateSourceTypeOnFailure: false,
  parseOpts: {sourceType: 'script', comment: true, tokens: true},
};

function rebuildFlatAst(script, sourceType, options) {
  if (sourceType !== 'script') return generateFlatAST(script, options);
  return generateFlatAST(script, {
    ...options,
    ...scriptParseOptions,
    parseOpts: {...options?.parseOpts, ...scriptParseOptions.parseOpts},
  });
}

function buildBatchedDeletionStates(ast, nodeIds) {
  const groupedTargets = new Map();
  for (let i = 0; i < nodeIds.length; i++) {
    const node = ast[nodeIds[i]];
    if (!node || node.nodeId !== nodeIds[i]) continue;
    const container = node.parentNode?.[node.parentKey];
    if (!Array.isArray(container)) continue;
    const targets = groupedTargets.get(container);
    if (targets) targets.set(node, -1);
    else groupedTargets.set(container, new Map([[node, -1]]));
  }

  const states = new Map();
  for (const [container, indexes] of groupedTargets) {
    if (indexes.size < batchedMutationMinimum) continue;
    for (let i = 0; i < container.length; i++) {
      if (indexes.has(container[i])) indexes.set(container[i], i);
    }
    let needsCommentNeighbors = false;
    for (const node of indexes.keys()) {
      if (node.leadingComments?.length || node.trailingComments?.length) {
        needsCommentNeighbors = true;
        break;
      }
    }
    let previous;
    let next;
    if (needsCommentNeighbors) {
      previous = new Int32Array(container.length);
      next = new Int32Array(container.length);
      for (let i = 0; i < container.length; i++) {
        previous[i] = i - 1;
        next[i] = i + 1 < container.length ? i + 1 : -1;
      }
    }
    states.set(container, {container, indexes, previous, next, remaining: container.length});
  }
  groupedTargets.clear();
  return states;
}

function compactDeletedSlots(container) {
  let writeIndex = 0;
  for (let readIndex = 0; readIndex < container.length; readIndex++) {
    if (container[readIndex] === deletedArraySlot) continue;
    if (readIndex in container) container[writeIndex] = container[readIndex];
    else delete container[writeIndex];
    writeIndex++;
  }
  container.length = writeIndex;
}

function buildBatchedReplacementIndexes(replacements) {
  const groupedTargets = new Map();
  for (let i = 0; i < replacements.length; i++) {
    const targetNode = replacements[i][0];
    const container = targetNode?.parentNode?.[targetNode.parentKey];
    if (!Array.isArray(container)) continue;
    const indexes = groupedTargets.get(container);
    if (indexes) indexes.set(targetNode, -1);
    else groupedTargets.set(container, new Map([[targetNode, -1]]));
  }

  for (const [container, indexes] of groupedTargets) {
    if (indexes.size < batchedMutationMinimum) {
      groupedTargets.delete(container);
      continue;
    }
    for (let i = 0; i < container.length; i++) {
      if (indexes.has(container[i])) indexes.set(container[i], i);
    }
  }
  return groupedTargets;
}

/**
 * Arborist allows marking nodes for deletion or replacement, and then applying all changes in a single pass.
 * Note: Calling markNode(), replaceNode(), or deleteNode() only queues a change; the AST is not officially changed until applyChanges() is called.
 */
export class Arborist {
  /**
   * @param {string|ASTNode[]} scriptOrFlatAstArr - The target script or a flat AST array.
   * @param {GenerateFlatASTOptions} [options] Flat AST generation options used for construction and rebuilds.
	 */
  constructor(scriptOrFlatAstArr, options = {}) {
    this.script                = '';
    this.ast                   = [];
    this.markedForDeletion     = [];  // Array of node ids.
    this.appliedCounter        = 0;   // Track the number of times changes were applied.
    this.replacements          = [];
    this.options               = options;
    this.logger = logger;
    if (typeof scriptOrFlatAstArr === 'string') {
      this.script = scriptOrFlatAstArr;
      this.ast = generateFlatAST(scriptOrFlatAstArr, options);
    } else if (Array.isArray(scriptOrFlatAstArr)) {
      this.ast = scriptOrFlatAstArr;
    } else throw Error('Undetermined argument');
  }

  /**
	 * When applicable, replace the provided node with its nearest parent node that can be removed without breaking the code.
	 * @param {ASTNode} startNode
	 * @return {ASTNode}
	 */
  _getCorrectTargetForDeletion(startNode) {
    let currentNode = startNode;
    while (currentNode.parentNode) {
      const parent = currentNode.parentNode;
      let canRemoveParent = parent.type === 'ExpressionStatement' ||
        parent.type === 'UnaryExpression' || parent.type === 'UpdateExpression';
      if (!canRemoveParent && parent.type === 'VariableDeclaration') {
        canRemoveParent = true;
        for (let i = 0; i < parent.declarations.length; i++) {
          const declaration = parent.declarations[i];
          if (declaration !== currentNode && !declaration.isMarked) {
            canRemoveParent = false;
            break;
          }
        }
      }
      if (!canRemoveParent) break;
      currentNode = parent;
    }
    if (currentNode.parentKey === 'consequent' || currentNode.parentKey === 'alternate') currentNode.isEmpty = true;
    return currentNode;
  }

  /**
	 * @returns {number} The number of changes to be applied.
	 */
  getNumberOfChanges() {
    return this.replacements.length + this.markedForDeletion.length;
  }

  /**
	 * Mark a node for replacement or deletion. This only sets a flag; the AST is not changed until applyChanges() is called.
	 * @param {ASTNode} targetNode The node to replace or remove.
	 * @param {object|ASTNode} [replacementNode] If exists, replace the target node with this node.
	 */
  markNode(targetNode, replacementNode) {
    let currentNode = targetNode;
    while (currentNode) {
      if (currentNode.isMarked) return;
      currentNode = currentNode.parentNode;
    }
    if (replacementNode) {  // Mark for replacement
      this.replacements.push([targetNode, replacementNode]);
      targetNode.isMarked = true;
    } else {                // Mark for deletion
      targetNode = this._getCorrectTargetForDeletion(targetNode);
      if (!targetNode.parentNode) return;
      if (targetNode.isEmpty) this.markNode(targetNode, {type: 'EmptyStatement'});
      else if (!targetNode.isMarked) {
        this.markedForDeletion.push(targetNode.nodeId);
        targetNode.isMarked = true;
      }
    }
  }

  /**
	 * Queue a node replacement. This is equivalent to markNode(targetNode, replacementNode),
	 * but is clearer at the call site when you are only replacing nodes.
	 * @param {ASTNode} targetNode The existing node to replace.
	 * @param {object|ASTNode} replacementNode The node that should replace the target.
	 */
  replaceNode(targetNode, replacementNode) {
    return this.markNode(targetNode, replacementNode);
  }

  /**
	 * Queue a node deletion. This is equivalent to markNode(targetNode),
	 * but is clearer at the call site when you are only deleting nodes.
	 * @param {ASTNode} targetNode The node to delete.
	 */
  deleteNode(targetNode) {
    return this.markNode(targetNode);
  }

  /**
	 * Merge comments from a source node into a target node or array.
	 * @param {ASTNode|Object} target - The node or array element to receive comments.
	 * @param {ASTNode} source - The node whose comments should be merged.
	 * @param {'leadingComments'|'trailingComments'} which
	 */
  static mergeComments(target, source, which) {
    if (!source[which] || !source[which].length) return;
    if (!target[which]) {
      target[which] = [...source[which]];
    } else if (target[which] !== source[which]) {
      target[which] = target[which].concat(source[which]);
    }
  }

  /**
	 * Iterate over the complete AST and replace / remove marked nodes,
	 * then rebuild code and AST to validate changes.
	 *
	 * Note: If you delete a node that is the only child of its parent (e.g., the only statement in a block),
	 * you may leave the parent in an invalid or empty state. Consider cleaning up empty parents if needed.
	 *
	 * @return {number} The number of modifications made.
	 */
  applyChanges() {
    let changesCounter = 0;
    let rootNode = this.ast[0];
    const originalSourceType = rootNode?.sourceType;
    let astWasMutated = false;
    let originalScript = this.script;
    const restoreAst = () => {
      if (!astWasMutated && this.ast.length) return;
      const restoredAst = rebuildFlatAst(originalScript, originalSourceType, this.options);
      if (restoredAst.length) this.ast = restoredAst;
    };
    try {
      if (this.getNumberOfChanges() > 0) {
        originalScript = rootNode?.src ?? (this.script || generateCode(rootNode));
        if (rootNode.isMarked) {
          const rootNodeReplacement = this.replacements.find(n => n[0].nodeId === 0);
          ++changesCounter;
          this.logger.debug('[+] Applying changes to the root node...');
          const leadingComments = rootNode.body?.[0]?.leadingComments || [];
          const trailingComments = rootNode.body?.[rootNode.body.length - 1]?.trailingComments || [];
          rootNode = rootNodeReplacement[1];
          if (leadingComments.length) {
            const leadingCommentTarget = rootNode.body?.[0] || rootNode;
            Arborist.mergeComments(leadingCommentTarget, {leadingComments}, 'leadingComments');
          }
          if (trailingComments.length) {
            const trailingCommentTarget = rootNode.body?.[rootNode.body.length - 1] || rootNode;
            Arborist.mergeComments(trailingCommentTarget, {trailingComments}, 'trailingComments');
          }
        } else {
          const batchedDeletionStates = buildBatchedDeletionStates(this.ast, this.markedForDeletion);
          for (const targetNodeId of this.markedForDeletion) {
            try {
              const targetNode = this.ast[targetNodeId];
              if (targetNode) {
                const parent = targetNode.parentNode;
                if (parent[targetNode.parentKey] === targetNode) {
                  delete parent[targetNode.parentKey];
                  astWasMutated = true;
                  Arborist.mergeComments(parent, targetNode, 'trailingComments');
                  ++changesCounter;
                } else if (Array.isArray(parent[targetNode.parentKey])) {
                  const container = parent[targetNode.parentKey];
                  const deletionState = batchedDeletionStates.get(container);
                  const idx = deletionState?.indexes.get(targetNode) ?? container.indexOf(targetNode);
                  if (idx !== -1) {
                    let previousIndex = idx - 1;
                    let nextIndex = idx + 1 < container.length ? idx + 1 : -1;
                    if (deletionState) {
                      if (container[idx] !== targetNode) continue;
                      if (deletionState.previous) {
                        previousIndex = deletionState.previous[idx];
                        nextIndex = deletionState.next[idx];
                        if (previousIndex !== -1) deletionState.next[previousIndex] = nextIndex;
                        if (nextIndex !== -1) deletionState.previous[nextIndex] = previousIndex;
                      }
                      container[idx] = deletedArraySlot;
                      deletionState.remaining--;
                    } else {
                      container.splice(idx, 1);
                      nextIndex = idx < container.length ? idx : -1;
                    }
                    astWasMutated = true;
                    const leadingComments = targetNode.leadingComments;
                    const trailingComments = targetNode.trailingComments;
                    if (leadingComments?.length || trailingComments?.length) {
                      const comments = leadingComments ? [...leadingComments] : [];
                      if (trailingComments) comments.push(...trailingComments);
                      let targetParent = null;
                      const remaining = deletionState?.remaining ?? container.length;
                      if (remaining > 0) {
                        if (previousIndex !== -1) {
                          targetParent = container[previousIndex];
                          Arborist.mergeComments(targetParent, {trailingComments: comments}, 'trailingComments');
                        } else {
                          targetParent = container[nextIndex];
                          Arborist.mergeComments(targetParent, {leadingComments: comments}, 'leadingComments');
                        }
                      } else {
                        this.logger.debug(`[!] Deleted last element from array '${targetNode.parentKey}' in parent node type '${parent.type}'. Array is now empty.`);
                        Arborist.mergeComments(parent, {trailingComments: comments}, 'trailingComments');
                      }
                    }
                    ++changesCounter;
                  }
                }
              }
            } catch (e) {
              this.logger.debug(`[-] Unable to delete node: ${e}`);
            }
          }
          for (const state of batchedDeletionStates.values()) {
            compactDeletedSlots(state.container);
            state.indexes.clear();
            state.previous = null;
            state.next = null;
          }
          batchedDeletionStates.clear();
          const batchedReplacementIndexes = buildBatchedReplacementIndexes(this.replacements);
          for (const [targetNode, replacementNode] of this.replacements) {
            try {
              if (targetNode) {
                const parent = targetNode.parentNode;
                if (parent[targetNode.parentKey] === targetNode) {
                  parent[targetNode.parentKey] = replacementNode;
                  astWasMutated = true;
                  Arborist.mergeComments(replacementNode, targetNode, 'leadingComments');
                  Arborist.mergeComments(replacementNode, targetNode, 'trailingComments');
                  ++changesCounter;
                } else if (Array.isArray(parent[targetNode.parentKey])) {
                  const container = parent[targetNode.parentKey];
                  const indexes = batchedReplacementIndexes.get(container);
                  const idx = indexes?.get(targetNode) ?? container.indexOf(targetNode);
                  if (idx === -1) continue;
                  container[idx] = replacementNode;
                  astWasMutated = true;
                  Arborist.mergeComments(replacementNode, targetNode, 'leadingComments');
                  Arborist.mergeComments(replacementNode, targetNode, 'trailingComments');
                  ++changesCounter;
                }
              }
            } catch (e) {
              this.logger.debug(`[-] Unable to replace node: ${e}`);
            }
          }
          for (const indexes of batchedReplacementIndexes.values()) indexes.clear();
          batchedReplacementIndexes.clear();
        }
      }
      if (changesCounter) {
        this.replacements.length = 0;
        this.markedForDeletion.length = 0;
        // If any of the changes made will break the script the next line will fail and the
        // script will remain the same. If it doesn't break, the changes are valid and the script can be marked as modified.
        const updatedSourceType = rootNode?.sourceType || originalSourceType;
        const script = generateCode(rootNode);
        rootNode = null;
        this.ast = [];
        const ast = rebuildFlatAst(script, updatedSourceType, this.options);
        if (ast && ast.length) {
          this.ast = ast;
          this.script = script;
        }
        else {
          this.logger.log(`[-] Modified script is invalid. Reverting ${changesCounter} changes...`);
          restoreAst();
          changesCounter = 0;
        }
      }
    } catch (e) {
      this.logger.log(`[-] Unable to apply changes to AST: ${e}`);
      restoreAst();
      changesCounter = 0;
    }
    ++this.appliedCounter;
    return changesCounter;
  }
}
