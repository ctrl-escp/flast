import {logger} from './utils/logger.js';
import {generateCode, generateFlatAST} from './flast.js';

/** @import {ASTNode, GenerateFlatASTOptions} from './types.d.ts' */

/**
 * @typedef {object} BatchedDeletionState
 * @property {Array<ASTNode|symbol|null>} container Mutated sibling container.
 * @property {Map<ASTNode, number>} indexes Target indexes in the container.
 * @property {Int32Array|undefined} previous Previous-live-sibling links when comments require them.
 * @property {Int32Array|undefined} next Next-live-sibling links when comments require them.
 * @property {number} remaining Number of live entries.
 */

/**
 * @typedef {object} CompactMetadataSnapshot
 * @property {number[][]} ancestries Per-node ancestry IDs.
 * @property {Int32Array} declarations Per-node declaration IDs, or -1.
 * @property {number[][]} lineages Per-node scope lineages.
 * @property {Int32Array} parentIds Per-node parent IDs, or -1.
 * @property {string[]} parentKeys Per-node structural keys.
 * @property {Array<number[]|undefined>} references Per-node reference IDs.
 * @property {Int32Array} scopeIds Per-node declared scope IDs, or -1.
 * @property {Int32Array} scopeIndexes Per-node indexes into the scope records.
 * @property {string[]} types Per-node ESTree types.
 * @property {boolean} hasComments Whether any parser or attached comments must be preserved.
 * @property {object[]} scopes Compact scope records.
 * @property {object[]} variables Compact variable records.
 * @property {Array<[string, number]>} allScopeEntries Root scope-ID mappings.
 */

const batchedMutationMinimum = 128;
const deletedArraySlot = Symbol('deletedArraySlot');
const scriptParseOptions = {
  alternateSourceTypeOnFailure: false,
  parseOpts: {sourceType: 'script', comment: true, tokens: true},
};

/**
 * Rebuild a flat AST while preserving an already-known script source type.
 * @param {string} script Source code to parse.
 * @param {string} sourceType Original program source type.
 * @param {GenerateFlatASTOptions} [options] Flat AST generation options.
 * @return {ASTNode[]} Rebuilt flat AST.
 */
function rebuildFlatAst(script, sourceType, options) {
  if (sourceType !== 'script') return generateFlatAST(script, options);
  // A known script may contain syntax that is invalid in strict module mode.
  // Parsing it directly avoids allocating an entire failed module parse first.
  return generateFlatAST(script, {
    ...options,
    ...scriptParseOptions,
    // User-selected token/comment retention still applies to scripts; only
    // sourceType must override a stale module setting.
    parseOpts: {...scriptParseOptions.parseOpts, ...options?.parseOpts, sourceType: 'script'},
  });
}

/**
 * Build per-container lookup state for large sibling-deletion batches.
 * @param {ASTNode[]} ast Current flat AST.
 * @param {number[]} nodeIds IDs queued for deletion.
 * @return {Map<Array<ASTNode|null>, BatchedDeletionState>} Batched deletion state keyed by parent container.
 */
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
    // Small batches are cheaper with indexOf/splice; the auxiliary maps only
    // repay their allocation cost when many siblings share one container.
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
      // Deletions leave sentinels until final compaction. These links retain
      // the nearest live comment target without repeatedly scanning siblings.
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

/**
 * Remove deletion sentinels from an array while preserving sparse holes.
 * @param {Array<ASTNode|symbol|null>} container Mutated child-node container.
 * @return {void}
 */
function compactDeletedSlots(container) {
  let writeIndex = 0;
  for (let readIndex = 0; readIndex < container.length; readIndex++) {
    if (container[readIndex] === deletedArraySlot) continue;
    // Checking ownership preserves intentional holes in sparse ESTree arrays.
    if (readIndex in container) container[writeIndex] = container[readIndex];
    else delete container[writeIndex];
    writeIndex++;
  }
  container.length = writeIndex;
}

/**
 * Index targets in large sibling-replacement batches.
 * @param {Array<[ASTNode, ASTNode|object]>} replacements Queued replacements.
 * @return {Map<Array<ASTNode|null>, Map<ASTNode, number>>} Target indexes keyed by parent container.
 */
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

const mutationImpact = {
  valueOnly: 0,
  expressionStructural: 1,
  referenceChanging: 2,
  bindingChanging: 3,
  commentChanging: 4,
  unknown: 5,
};

const bindingNodeTypes = new Set([
  'ArrayPattern', 'AssignmentPattern', 'CatchClause', 'ClassDeclaration', 'ClassExpression',
  'ExportAllDeclaration', 'ExportDefaultDeclaration', 'ExportNamedDeclaration', 'FunctionDeclaration',
  'FunctionExpression', 'ImportDeclaration', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier',
  'ImportSpecifier', 'ObjectPattern', 'RestElement', 'VariableDeclaration', 'VariableDeclarator',
]);

const reusableOperatorChildKeys = {
  AssignmentExpression: ['left', 'right'],
  BinaryExpression: ['left', 'right'],
  LogicalExpression: ['left', 'right'],
  UpdateExpression: ['argument'],
};

/**
 * Identify the syntax category of an ESTree Literal.
 * @param {ASTNode|object} node Literal node.
 * @return {string} Stable literal category used for conservative classification.
 */
function literalCategory(node) {
  if (node.regex || node.value instanceof RegExp) return 'regexp';
  if (node.bigint !== undefined || typeof node.value === 'bigint') return 'bigint';
  if (node.value === null) return 'null';
  return typeof node.value;
}

/**
 * Verify that an operator replacement retains the exact operand subtrees.
 * @param {ASTNode} targetNode Existing expression node.
 * @param {ASTNode|object} replacementNode Replacement expression node.
 * @return {boolean} Whether only operator-level fields can affect generated syntax.
 */
function hasReusableOperatorChildren(targetNode, replacementNode) {
  if (targetNode.type !== replacementNode.type || typeof replacementNode.operator !== 'string') return false;
  const childKeys = reusableOperatorChildKeys[targetNode.type];
  if (!childKeys) return false;
  // Requiring object identity prevents a replacement from smuggling changed
  // identifiers or bindings into an otherwise whitelisted expression type.
  for (let i = 0; i < childKeys.length; i++) {
    const key = childKeys[i];
    if (targetNode[key] !== replacementNode[key]) return false;
  }
  return true;
}

/**
 * Classify one replacement by the metadata work it may invalidate.
 * @param {ASTNode} targetNode Existing AST node.
 * @param {ASTNode|object} replacementNode Queued replacement.
 * @return {number} Mutation-impact level.
 */
function classifyReplacement(targetNode, replacementNode) {
  if (!targetNode || !replacementNode || typeof replacementNode.type !== 'string') return mutationImpact.unknown;
  if ((targetNode.leadingComments !== replacementNode.leadingComments && replacementNode.leadingComments?.length) ||
    (targetNode.trailingComments !== replacementNode.trailingComments && replacementNode.trailingComments?.length)) {
    return mutationImpact.commentChanging;
  }
  if (targetNode.type === 'Literal' && replacementNode.type === 'Literal') {
    // Directive literals can change strict-mode scope semantics. Matching
    // categories also excludes values such as negative numbers that reparse
    // into a different ESTree shape.
    if (targetNode.parentNode?.directive !== undefined) return mutationImpact.unknown;
    return literalCategory(targetNode) === literalCategory(replacementNode) ?
      mutationImpact.valueOnly : mutationImpact.unknown;
  }
  if (hasReusableOperatorChildren(targetNode, replacementNode)) {
    return mutationImpact.expressionStructural;
  }
  if (bindingNodeTypes.has(targetNode.type) || bindingNodeTypes.has(replacementNode.type)) {
    return mutationImpact.bindingChanging;
  }
  if (targetNode.type === 'Identifier' || replacementNode.type === 'Identifier') return mutationImpact.referenceChanging;
  return mutationImpact.unknown;
}

/**
 * Compute the highest mutation impact in a queued batch.
 * @param {Array<[ASTNode, ASTNode|object]>} replacements Queued replacements.
 * @param {number[]} deletions Queued deletion node IDs.
 * @return {number} Aggregate mutation-impact level.
 */
function classifyMutationBatch(replacements, deletions) {
  if (deletions.length || !replacements.length) return mutationImpact.unknown;
  let impact = mutationImpact.valueOnly;
  for (let i = 0; i < replacements.length; i++) {
    impact = Math.max(impact, classifyReplacement(replacements[i][0], replacements[i][1]));
  }
  return impact;
}

/**
 * Capture compact detailed metadata without retaining references to AST nodes.
 * @param {ASTNode[]} ast Current compact-scope flat AST.
 * @return {CompactMetadataSnapshot|null} ID-based metadata snapshot, or null when metadata cannot be reused.
 */
function captureCompactMetadata(ast) {
  if (!ast[0]?.allScopes) return null;
  const nodeCount = ast.length;
  const snapshot = {
    ancestries: new Array(nodeCount),
    declarations: new Int32Array(nodeCount).fill(-1),
    lineages: new Array(nodeCount),
    parentIds: new Int32Array(nodeCount).fill(-1),
    parentKeys: new Array(nodeCount),
    references: new Array(nodeCount),
    scopeIds: new Int32Array(nodeCount).fill(-1),
    scopeIndexes: new Int32Array(nodeCount).fill(-1),
    types: new Array(nodeCount),
    hasComments: Boolean(ast[0].comments?.length),
  };
  const scopeIndexes = new Map();
  const scopes = [];
  const pendingScopes = Object.values(ast[0].allScopes);
  while (pendingScopes.length) {
    const scope = pendingScopes.pop();
    if (!scope || scopeIndexes.has(scope)) continue;
    scopeIndexes.set(scope, scopes.length);
    scopes.push(scope);
    // Some function-name/module scopes are intentionally absent from
    // allScopes but remain necessary through upper/variableScope links.
    if (scope.upper) pendingScopes.push(scope.upper);
    if (scope.variableScope) pendingScopes.push(scope.variableScope);
    for (let i = 0; i < scope.childScopes.length; i++) pendingScopes.push(scope.childScopes[i]);
  }

  const variableIndexes = new Map();
  const variables = [];
  /**
   * Get or create the snapshot index for a compact scope variable.
   * @param {object|null|undefined} variable Compact scope variable.
   * @return {number} Variable record index, or -1 for an unresolved reference.
   */
  const getVariableIndex = variable => {
    if (!variable) return -1;
    let index = variableIndexes.get(variable);
    if (index === undefined) {
      index = variables.length;
      variableIndexes.set(variable, index);
      variables.push({
        identifiers: variable.identifiers.map(identifier => identifier.nodeId),
        name: variable.name,
      });
    }
    return index;
  };
  snapshot.scopes = scopes.map(scope => ({
    blockId: scope.block.nodeId,
    childIndexes: scope.childScopes.map(child => scopeIndexes.get(child)),
    referenceRecords: scope.references.map(reference => [
      reference.identifier.nodeId,
      getVariableIndex(reference.resolved),
    ]),
    scopeId: scope.scopeId,
    type: scope.type,
    upperIndex: scopeIndexes.get(scope.upper) ?? -1,
    variableIndexes: scope.variables.map(getVariableIndex),
    variableScopeIndex: scopeIndexes.get(scope.variableScope) ?? -1,
  }));
  snapshot.variables = variables;
  snapshot.allScopeEntries = Object.entries(ast[0].allScopes)
    .map(([scopeId, scope]) => [scopeId, scopeIndexes.get(scope)]);

  for (let i = 0; i < nodeCount; i++) {
    const node = ast[i];
    if (!Array.isArray(node.ancestry) || !Array.isArray(node.lineage) || !node.scope) return null;
    snapshot.ancestries[i] = node.ancestry;
    snapshot.lineages[i] = node.lineage;
    snapshot.parentIds[i] = node.parentNode?.nodeId ?? -1;
    snapshot.parentKeys[i] = node.parentKey;
    snapshot.scopeIndexes[i] = scopeIndexes.get(node.scope) ?? -1;
    snapshot.types[i] = node.type;
    if (node.leadingComments?.length || node.trailingComments?.length || node.innerComments?.length) {
      snapshot.hasComments = true;
    }
    if (node.scopeId !== undefined) snapshot.scopeIds[i] = node.scopeId;
    if (node.declNode) snapshot.declarations[i] = node.declNode.nodeId;
    if (node.references) snapshot.references[i] = node.references.map(reference => reference.nodeId);
  }
  // The snapshot contains IDs, strings, and number arrays rather than nodes.
  // This lets the obsolete cyclic AST become collectible before reparsing.
  return snapshot;
}

/**
 * Validate structural correspondence and restore captured detailed metadata.
 * @param {CompactMetadataSnapshot|null} snapshot ID-based metadata snapshot.
 * @param {ASTNode[]} ast Newly parsed basic flat AST.
 * @return {boolean} Whether validation and metadata restoration succeeded.
 */
function applyCompactMetadata(snapshot, ast) {
  if (!snapshot || snapshot.types.length !== ast.length) return false;
  for (let i = 0; i < ast.length; i++) {
    // Equal offsets are not unique, so correspondence is proven with traversal
    // identity: node order, type, parent key, and parent ID must all agree.
    if (snapshot.types[i] !== ast[i].type || snapshot.parentKeys[i] !== ast[i].parentKey ||
      snapshot.parentIds[i] !== (ast[i].parentNode?.nodeId ?? -1)) return false;
  }

  const variables = snapshot.variables.map(variable => ({
    identifiers: variable.identifiers.map(nodeId => ast[nodeId]),
    name: variable.name,
  }));
  const scopes = snapshot.scopes.map(scope => ({
    block: ast[scope.blockId],
    childScopes: [],
    scopeId: scope.scopeId,
    type: scope.type,
    upper: null,
    variables: [],
    references: [],
  }));
  // Variables and scope shells are created first so cyclic scope links and
  // resolved references preserve shared object identity during the second pass.
  for (let i = 0; i < scopes.length; i++) {
    const record = snapshot.scopes[i];
    scopes[i].upper = scopes[record.upperIndex] || null;
    scopes[i].variableScope = scopes[record.variableScopeIndex];
    scopes[i].childScopes = record.childIndexes.map(index => scopes[index]);
    scopes[i].variables = record.variableIndexes.map(index => variables[index]);
    scopes[i].references = record.referenceRecords.map(([nodeId, variableIndex]) => ({
      identifier: ast[nodeId],
      resolved: variables[variableIndex],
    }));
  }

  for (let i = 0; i < ast.length; i++) {
    ast[i].ancestry = [...snapshot.ancestries[i]];
    ast[i].lineage = [...snapshot.lineages[i]];
    ast[i].scope = scopes[snapshot.scopeIndexes[i]];
    if (snapshot.scopeIds[i] !== -1) ast[i].scopeId = snapshot.scopeIds[i];
    if (snapshot.declarations[i] !== -1) ast[i].declNode = ast[snapshot.declarations[i]];
    if (snapshot.references[i]) ast[i].references = snapshot.references[i].map(nodeId => ast[nodeId]);
  }
  ast[0].allScopes = Object.fromEntries(snapshot.allScopeEntries.map(([scopeId, index]) => [scopeId, scopes[index]]));
  return true;
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
	 * @return {void}
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
	 * @return {void}
	 */
  replaceNode(targetNode, replacementNode) {
    return this.markNode(targetNode, replacementNode);
  }

  /**
	 * Queue a node deletion. This is equivalent to markNode(targetNode),
	 * but is clearer at the call site when you are only deleting nodes.
	 * @param {ASTNode} targetNode The node to delete.
	 * @return {void}
	 */
  deleteNode(targetNode) {
    return this.markNode(targetNode);
  }

  /**
	 * Merge comments from a source node into a target node or array.
	 * @param {ASTNode|Object} target - The node or array element to receive comments.
	 * @param {ASTNode} source - The node whose comments should be merged.
	 * @param {'leadingComments'|'trailingComments'} which
	 * @return {void}
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
    // Raw eslint-scope objects retain old AST nodes and cannot be remapped
    // safely. Metadata reuse is therefore restricted to compact scopes.
    let canReuseDetailedMetadata = this.options.compactScopes === true && this.options.detailed !== false &&
      classifyMutationBatch(this.replacements, this.markedForDeletion) <= mutationImpact.expressionStructural;
    const metadataSnapshot = canReuseDetailedMetadata ? captureCompactMetadata(this.ast) : null;
    if (!metadataSnapshot) canReuseDetailedMetadata = false;
    // Without comments or retained tokens, producing lexer output only to
    // discard it adds parse time and transient memory without affecting AST output.
    const canUseLeanBasicParse = canReuseDetailedMetadata && this.options.retainTokens === false &&
      !metadataSnapshot.hasComments;
    let astWasMutated = false;
    let originalScript = this.script;
    /**
     * Restore a discarded or mutated AST from its original source.
     * @return {void}
     */
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
        // Code generation is the last operation that needs the mutated graph.
        // Release it before allocating the replacement AST to reduce overlap.
        rootNode = null;
        this.ast = [];
        let ast;
        if (canReuseDetailedMetadata) {
          const basicOptions = {...this.options, detailed: false};
          if (canUseLeanBasicParse) {
            basicOptions.parseOpts = {...this.options.parseOpts, comment: false, tokens: false};
          }
          ast = rebuildFlatAst(script, updatedSourceType, basicOptions);
          if (!applyCompactMetadata(metadataSnapshot, ast)) {
            // Do not keep the rejected basic AST alive while allocating the
            // authoritative full rebuild.
            ast = [];
            ast = rebuildFlatAst(script, updatedSourceType, this.options);
          }
        } else {
          ast = rebuildFlatAst(script, updatedSourceType, this.options);
        }
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
