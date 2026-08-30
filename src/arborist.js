import {logger} from './utils/logger.js';
import {shouldUseNextMajorDefaults} from './utils/nextMajorDefaults.js';
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
 * @property {Int32Array} declarations Packed ID pairs or a dense per-node declaration map.
 * @property {boolean} declarationsArePacked Whether declarations contains reference/declaration pairs.
 * @property {Int32Array} parentIds Per-node parent IDs, or -1.
 * @property {string[]} parentKeys Per-node structural keys.
 * @property {Uint16Array|Uint32Array} scopeIndexes Per-node indexes into the scope records.
 * @property {string[]} types Per-node ESTree types.
 * @property {boolean} hasComments Whether any parser or attached comments must be preserved.
 * @property {object[]} scopes Compact scope records.
 * @property {object[]} variables Compact variable records.
 * @property {Array<[string, number]>} allScopeEntries Root scope-ID mappings.
 */

const batchedMutationMinimum = 128;
// Below the large-batch cutoff, enough adjacent targets must share the scan
// before temporary index bookkeeping reliably repays its fixed cost.
const adjacentMutationMinimum = 16;
const deletedArraySlot = Symbol('deletedArraySlot');
const scriptParseOptions = {
  alternateSourceTypeOnFailure: false,
  parseOpts: {sourceType: 'script', comment: true, tokens: true},
};

/**
 * Allocate the narrowest scope-index array allowed by the snapshot format.
 *
 * @example
 * createScopeIndexArray(100, 12) instanceof Uint16Array; // true
 * createScopeIndexArray(100, 70000) instanceof Uint32Array; // true
 *
 * @param {number} length Number of indexes to store.
 * @param {number} cardinality Number of scope records.
 * @return {Uint16Array|Uint32Array|null} Narrow index array, or null above uint32 capacity.
 */
function createScopeIndexArray(length, cardinality) {
  if (cardinality <= 0x10000) return new Uint16Array(length);
  if (cardinality <= 0x100000000) return new Uint32Array(length);
  return null;
}

/**
 * Rebuild a flat AST while preserving an already-known script source type.
 *
 * @example
 * // This must remain a script: reparsing it as a module first would fail
 * // because modules are strict and do not permit `with`.
 * rebuildFlatAst('with (target) { read(); }', 'script', options);
 *
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
 * Index targets queued in the same order as one contiguous child-array run.
 *
 * @example
 * const container = [first, second, third, fourth];
 * indexOrderedAdjacentTargets(
 *   container,
 *   new Map([[second, -1], [third, -1]]),
 * ); // true: indexes 1 and 2 are recorded.
 *
 * @example
 * indexOrderedAdjacentTargets(
 *   container,
 *   new Map([[second, -1], [fourth, -1]]),
 * ); // false: a gap makes the one-pass adjacent optimization unsafe.
 *
 * @param {Array<ASTNode|null>} container Parent child-node array.
 * @param {Map<ASTNode, number>} indexes Ordered targets mapped to their indexes.
 * @return {boolean} Whether every target was found in one forward-adjacent run.
 */
function indexOrderedAdjacentTargets(container, indexes) {
  let expectedIndex = -1;
  for (const targetNode of indexes.keys()) {
    if (expectedIndex === -1) expectedIndex = container.indexOf(targetNode);
    if (expectedIndex === -1 || container[expectedIndex] !== targetNode) return false;
    indexes.set(targetNode, expectedIndex++);
  }
  return true;
}

/**
 * Build per-container lookup state for large or ordered-adjacent sibling deletions.
 *
 * @example
 * // Deleting a contiguous run from one block creates one state entry so each
 * // deletion uses its recorded index and the array is compacted only once.
 * const states = buildBatchedDeletionStates(ast, statementNodeIds);
 * states.get(block.body).indexes.get(block.body[0]); // 0
 *
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
    if (indexes.size < adjacentMutationMinimum) continue;
    let needsCommentNeighbors = false;
    for (const node of indexes.keys()) {
      if (node.leadingComments?.length || node.trailingComments?.length) {
        needsCommentNeighbors = true;
        break;
      }
    }
    if (indexes.size < batchedMutationMinimum) {
      // Medium comment-free runs can leave sentinels and compact once without
      // allocating full sibling-neighbor tables. Scattered or comment-bearing
      // edits retain splice semantics until their batch is large enough.
      if (needsCommentNeighbors || !indexOrderedAdjacentTargets(container, indexes)) continue;
    } else {
      for (let i = 0; i < container.length; i++) {
        if (indexes.has(container[i])) indexes.set(container[i], i);
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
 *
 * @example
 * const elements = [first, deletedArraySlot, , fourth];
 * compactDeletedSlots(elements);
 * elements.length; // 3
 * 1 in elements; // false: the original sparse hole remains a hole.
 *
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
 * Index targets in large or ordered-adjacent sibling-replacement batches.
 *
 * @example
 * const indexesByContainer = buildBatchedReplacementIndexes(replacements);
 * indexesByContainer.get(block.body).get(targetStatement); // target's array index
 *
 * @example
 * // A small or scattered batch is omitted because individual indexOf()
 * // lookups cost less than allocating and populating a batch index.
 * buildBatchedReplacementIndexes(scatteredReplacements).has(block.body); // false
 *
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
    if (indexes.size < adjacentMutationMinimum) {
      groupedTargets.delete(container);
      continue;
    }
    if (indexes.size < batchedMutationMinimum) {
      // Callers commonly queue a slice of an ESTree child array in order.
      // Recognizing that run avoids one linear indexOf() scan per target.
      if (!indexOrderedAdjacentTargets(container, indexes)) groupedTargets.delete(container);
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
  UnaryExpression: ['argument'],
  UpdateExpression: ['argument'],
};

const reusableOperators = {
  AssignmentExpression: new Set([
    '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '|=', '^=', '&=', '||=', '&&=', '??=',
  ]),
  BinaryExpression: new Set([
    '==', '!=', '===', '!==', '<', '<=', '>', '>=', '<<', '>>', '>>>', '+', '-', '*', '/', '%', '**',
    '|', '^', '&', 'in', 'instanceof',
  ]),
  LogicalExpression: new Set(['||', '&&', '??']),
  UnaryExpression: new Set(['-', '+', '!', '~', 'typeof', 'void', 'delete']),
  UpdateExpression: new Set(['++', '--']),
};

/**
 * Identify the syntax category of an ESTree Literal.
 *
 * @example
 * literalCategory({type: 'Literal', value: 1}); // 'number'
 * literalCategory({type: 'Literal', value: 1n, bigint: '1'}); // 'bigint'
 * literalCategory({type: 'Literal', value: /x/, regex: {pattern: 'x', flags: ''}}); // 'regexp'
 *
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
 * Check whether code generation preserves a replacement Literal's node shape.
 *
 * @example
 * hasReusableLiteralShape({type: 'Literal', value: 2}, 'number'); // true
 * hasReusableLiteralShape({type: 'Literal', value: -2}, 'number'); // false
 * // `-2` reparses as UnaryExpression(Literal(2)), not as one Literal.
 *
 * @param {ASTNode|object} node Replacement literal.
 * @param {string} category Literal category returned by literalCategory().
 * @return {boolean} Whether reparsing can still produce one Literal node.
 */
function hasReusableLiteralShape(node, category) {
  if (category === 'number') {
    // Negative numbers and NaN cannot be emitted as one ESTree Literal.
    return typeof node.value === 'number' && !Number.isNaN(node.value) && node.value >= 0 && !Object.is(node.value, -0);
  }
  if (category === 'bigint') {
    if (typeof node.value === 'bigint') return node.value >= 0n;
    return typeof node.bigint === 'string' && !node.bigint.trimStart().startsWith('-');
  }
  return true;
}

/**
 * Check whether TemplateElement text cannot change its surrounding AST shape.
 *
 * @example
 * const target = {type: 'TemplateElement', tail: false};
 * hasReusableTemplateElementShape(target, {
 *   type: 'TemplateElement',
 *   tail: false,
 *   value: {raw: 'Hello ', cooked: 'Hello '},
 * }); // true
 *
 * @example
 * hasReusableTemplateElementShape(target, {
 *   type: 'TemplateElement',
 *   tail: false,
 *   value: {raw: '${user}', cooked: '${user}'},
 * }); // false: `${` would introduce a new expression subtree.
 *
 * @param {ASTNode} targetNode Existing template element.
 * @param {ASTNode|object} replacementNode Replacement template element.
 * @return {boolean} Whether reparsing preserves one element in the same quasi position.
 */
function hasReusableTemplateElementShape(targetNode, replacementNode) {
  const raw = replacementNode.value?.raw;
  if (replacementNode.type !== 'TemplateElement' || replacementNode.tail !== targetNode.tail ||
    typeof raw !== 'string') return false;
  // Backslashes make delimiter escaping context-dependent. A raw backtick can
  // terminate the template, while `${` introduces an entirely new subtree.
  return !raw.includes('\\') && !raw.includes('`') && !raw.includes('${');
}

/**
 * Check whether a yield replacement changes only delegation syntax.
 *
 * @example
 * const argument = targetNode.argument;
 * hasReusableYieldShape(targetNode, {
 *   type: 'YieldExpression',
 *   argument,
 *   delegate: true,
 * }); // true: `yield value` may become `yield* value`.
 *
 * @example
 * hasReusableYieldShape(targetNode, {
 *   type: 'YieldExpression',
 *   argument: {...argument},
 *   delegate: true,
 * }); // false: a different argument object may contain other mutations.
 *
 * @param {ASTNode} targetNode Existing yield expression.
 * @param {ASTNode|object} replacementNode Replacement yield expression.
 * @return {boolean} Whether the exact argument subtree remains in place.
 */
function hasReusableYieldShape(targetNode, replacementNode) {
  return replacementNode.type === 'YieldExpression' && replacementNode.argument === targetNode.argument &&
    typeof replacementNode.delegate === 'boolean' && (!replacementNode.delegate || Boolean(replacementNode.argument));
}

/**
 * Check whether a node is structurally enclosed by an async function.
 *
 * @example
 * const asyncFunction = {type: 'FunctionDeclaration', async: true, parentNode: null};
 * isInsideAsyncFunction({parentNode: asyncFunction}); // true
 *
 * @example
 * const syncFunction = {type: 'FunctionExpression', async: false, parentNode: asyncFunction};
 * isInsideAsyncFunction({parentNode: syncFunction}); // false
 * // The nearest function boundary wins; an async outer function is irrelevant.
 *
 * @param {ASTNode} node Node whose nearest function ancestor should be checked.
 * @return {boolean} Whether the nearest function boundary is async.
 */
function isInsideAsyncFunction(node) {
  let parent = node.parentNode;
  while (parent) {
    if (parent.type === 'ArrowFunctionExpression' || parent.type === 'FunctionDeclaration' ||
      parent.type === 'FunctionExpression') return parent.async === true;
    parent = parent.parentNode;
  }
  return false;
}

/**
 * Check whether a for-of replacement changes only asynchronous iteration.
 *
 * @example
 * const replacement = {
 *   type: 'ForOfStatement',
 *   await: true,
 *   left: targetNode.left,
 *   right: targetNode.right,
 *   body: targetNode.body,
 * };
 * hasReusableForOfShape(targetNode, replacement); // true only inside an async function.
 *
 * @example
 * hasReusableForOfShape(targetNode, {
 *   ...replacement,
 *   right: {...targetNode.right},
 * }); // false: changing the iterated expression can invalidate references.
 *
 * @param {ASTNode} targetNode Existing for-of statement.
 * @param {ASTNode|object} replacementNode Replacement for-of statement.
 * @return {boolean} Whether loop structure and binding metadata remain unchanged.
 */
function hasReusableForOfShape(targetNode, replacementNode) {
  return replacementNode.type === 'ForOfStatement' && typeof replacementNode.await === 'boolean' &&
    replacementNode.left === targetNode.left && replacementNode.right === targetNode.right &&
    replacementNode.body === targetNode.body && (!replacementNode.await || isInsideAsyncFunction(targetNode));
}

/**
 * Verify that an operator replacement retains the exact operand subtrees.
 *
 * @example
 * hasReusableOperatorChildren(targetNode, {
 *   type: 'BinaryExpression',
 *   operator: '-',
 *   left: targetNode.left,
 *   right: targetNode.right,
 * }); // true when targetNode is a BinaryExpression.
 *
 * @example
 * hasReusableOperatorChildren(targetNode, {
 *   type: 'BinaryExpression',
 *   operator: '&&',
 *   left: targetNode.left,
 *   right: targetNode.right,
 * }); // false: `&&` reparses as a LogicalExpression.
 *
 * @param {ASTNode} targetNode Existing expression node.
 * @param {ASTNode|object} replacementNode Replacement expression node.
 * @return {boolean} Whether only operator-level fields can affect generated syntax.
 */
function hasReusableOperatorChildren(targetNode, replacementNode) {
  if (targetNode.type !== replacementNode.type || typeof replacementNode.operator !== 'string') return false;
  const childKeys = reusableOperatorChildKeys[targetNode.type];
  if (!childKeys || !reusableOperators[targetNode.type].has(replacementNode.operator)) return false;
  // Operator families are part of ESTree node identity: `&&` reparses as a
  // LogicalExpression even if a caller labels it as a BinaryExpression.
  if (targetNode.type === 'AssignmentExpression' &&
    (targetNode.left.type === 'ArrayPattern' || targetNode.left.type === 'ObjectPattern') &&
    replacementNode.operator !== '=') {
    // Destructuring targets are only valid with plain assignment. Rejecting
    // compound operators here avoids parsing source that cannot be valid.
    return false;
  }
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
 *
 * The classifier is intentionally conservative: only `valueOnly` and
 * `expressionStructural` replacements may reuse compact scope metadata.
 *
 * @example
 * classifyReplacement(
 *   {type: 'Literal', value: 1, parentNode: {}},
 *   {type: 'Literal', value: 2},
 * ); // mutationImpact.valueOnly
 *
 * @example
 * classifyReplacement(
 *   {type: 'Identifier', name: 'before'},
 *   {type: 'Identifier', name: 'after'},
 * ); // mutationImpact.referenceChanging
 *
 * @example
 * classifyReplacement(
 *   {type: 'Literal', value: 1, parentNode: {}},
 *   {type: 'Literal', value: -1},
 * ); // mutationImpact.unknown: the generated AST gains a UnaryExpression.
 *
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
    const replacementCategory = literalCategory(replacementNode);
    return literalCategory(targetNode) === replacementCategory &&
      hasReusableLiteralShape(replacementNode, replacementCategory) ?
      mutationImpact.valueOnly : mutationImpact.unknown;
  }
  if (targetNode.type === 'TemplateElement') {
    return hasReusableTemplateElementShape(targetNode, replacementNode) ?
      mutationImpact.valueOnly : mutationImpact.unknown;
  }
  if (targetNode.type === 'YieldExpression') {
    return hasReusableYieldShape(targetNode, replacementNode) ?
      mutationImpact.expressionStructural : mutationImpact.unknown;
  }
  if (targetNode.type === 'ForOfStatement') {
    return hasReusableForOfShape(targetNode, replacementNode) ?
      mutationImpact.expressionStructural : mutationImpact.unknown;
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
 *
 * @example
 * classifyMutationBatch([
 *   [
 *     {type: 'Literal', value: 1, parentNode: {}},
 *     {type: 'Literal', value: 2},
 *   ],
 * ], []); // mutationImpact.valueOnly
 *
 * @example
 * classifyMutationBatch(replacements, [deletedNodeId]);
 * // mutationImpact.unknown: any deletion can renumber or restructure nodes.
 *
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
 *
 * @example
 * const snapshot = captureCompactMetadata(oldAst);
 * // A declaration link such as oldAst[8].declNode === oldAst[3] is stored as
 * // the numeric ID 3, allowing the entire old AST to be garbage-collected.
 *
 * @param {ASTNode[]} ast Current compact-scope flat AST.
 * @return {CompactMetadataSnapshot|null} ID-based metadata snapshot, or null when metadata cannot be reused.
 */
function captureCompactMetadata(ast) {
  if (!ast[0]?.allScopes) return null;
  const nodeCount = ast.length;
  const typeMap = ast[0].typeMap;
  const identifiers = typeMap?.Identifier;
  if (!Array.isArray(identifiers)) return null;
  let declarationCount = 0;
  for (let i = 0; i < identifiers.length; i++) {
    const identifier = identifiers[i];
    // Declaration packing is the only snapshot decision that trusts typeMap.
    // Validate those entries now; the final offset check detects omissions.
    if (identifier?.type !== 'Identifier' || ast[identifier.nodeId] !== identifier) return null;
    if (identifier.declNode) declarationCount++;
  }
  const declarationsArePacked = declarationCount * 2 < nodeCount;
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

  const nodeScopeIndexes = createScopeIndexArray(nodeCount, scopes.length);
  if (!nodeScopeIndexes) return null;
  const snapshot = {
    declarations: new Int32Array(declarationsArePacked ? declarationCount * 2 : nodeCount),
    declarationsArePacked,
    parentIds: new Int32Array(nodeCount).fill(-1),
    parentKeys: new Array(nodeCount),
    scopeIndexes: nodeScopeIndexes,
    types: new Array(nodeCount),
    hasComments: Boolean(ast[0].comments?.length),
  };
  if (!declarationsArePacked) snapshot.declarations.fill(-1);

  const variableIndexes = new Map();
  const variables = [];
  /**
   * Get or create the snapshot index for a compact scope variable.
   *
   * @example
   * getVariableIndex(variable) === getVariableIndex(variable); // true
   * getVariableIndex(null); // -1
   *
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

  let declarationOffset = 0;
  for (let i = 0; i < nodeCount; i++) {
    const node = ast[i];
    if (!node.scope) return null;
    const scopeIndex = scopeIndexes.get(node.scope);
    // Every node scope must resolve into the captured graph. Otherwise the
    // rebuilt lineage could silently point at incomplete scope metadata.
    if (scopeIndex === undefined) return null;
    const parentKey = node.parentKey;
    if (typeof parentKey !== 'string') return null;
    snapshot.parentIds[i] = node.parentNode?.nodeId ?? -1;
    snapshot.scopeIndexes[i] = scopeIndex;
    snapshot.parentKeys[i] = parentKey;
    snapshot.types[i] = node.type;
    if (node.leadingComments?.length || node.trailingComments?.length || node.innerComments?.length) {
      snapshot.hasComments = true;
    }
    if (node.declNode) {
      if (declarationsArePacked) {
        snapshot.declarations[declarationOffset++] = i;
        snapshot.declarations[declarationOffset++] = node.declNode.nodeId;
      } else {
        snapshot.declarations[i] = node.declNode.nodeId;
      }
    }
  }
  // A stale typeMap could under-size the packed array and silently discard
  // writes. Reject reuse instead of restoring incomplete declaration links.
  if (declarationsArePacked && declarationOffset !== snapshot.declarations.length) return null;
  scopeIndexes.clear();
  variableIndexes.clear();
  // Derived scope IDs, inverse-reference, ancestry, and lineage metadata are
  // intentionally omitted. Retaining per-node copies would increase peak
  // memory, while scope records and forward links can rebuild all four.
  return snapshot;
}

/**
 * Validate that a basic rebuild corresponds exactly to one compact snapshot.
 *
 * Validation completes before scope or variable objects are allocated. The
 * large structural arrays are then released because restoration only needs
 * scope and declaration indexes.
 *
 * @example
 * validateCompactMetadata(snapshot, reparsedAst); // true
 * snapshot.parentIds; // null: validation-only memory was released.
 *
 * @param {CompactMetadataSnapshot|null} snapshot ID-based metadata snapshot.
 * @param {ASTNode[]} ast Newly parsed basic flat AST.
 * @return {boolean} Whether structural correspondence is exact.
 */
function validateCompactMetadata(snapshot, ast) {
  if (!snapshot || snapshot.parentIds.length !== ast.length) return false;
  const scopeCount = snapshot.scopes.length;
  for (let i = 0; i < ast.length; i++) {
    // Equal offsets are not unique, so correspondence is proven with traversal
    // identity: node order, type, parent key, and parent ID must all agree.
    if (snapshot.types[i] !== ast[i].type || snapshot.parentKeys[i] !== ast[i].parentKey ||
      snapshot.parentIds[i] !== (ast[i].parentNode?.nodeId ?? -1) ||
      snapshot.scopeIndexes[i] >= scopeCount) return false;
  }

  // These arrays dominate validation overlap and have no role in restoration.
  snapshot.parentIds = null;
  snapshot.parentKeys = null;
  snapshot.types = null;
  return true;
}

/**
 * Restore captured detailed metadata after structural validation succeeds.
 *
 * @example
 * const snapshot = captureCompactMetadata(oldAst);
 * const reparsedAst = generateFlatAST(updatedSource, {detailed: false});
 * applyCompactMetadata(snapshot, reparsedAst);
 * // true only when every node still has the same index, type, parent key,
 * // and parent ID; restored links then point exclusively into reparsedAst.
 *
 * @param {CompactMetadataSnapshot|null} snapshot ID-based metadata snapshot.
 * @param {ASTNode[]} ast Newly parsed basic flat AST.
 * @return {boolean} Whether validation and metadata restoration succeeded.
 */
function applyCompactMetadata(snapshot, ast) {
  if (!validateCompactMetadata(snapshot, ast)) return false;
  const variables = snapshot.variables.map(variable => ({
    identifiers: variable.identifiers.map(nodeId => ast[nodeId]),
    name: variable.name,
  }));
  for (let i = 0; i < variables.length; i++) {
    const identifiers = variables[i].identifiers;
    // Declaration reference arrays are the inverse of saved declNode links.
    // Initialize every declaration, including declarations with no references.
    for (let j = 0; j < identifiers.length; j++) identifiers[j].references = [];
  }
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
    const scope = scopes[i];
    scope.upper = scopes[record.upperIndex] || null;
    scope.variableScope = scopes[record.variableScopeIndex];
    scope.childScopes = record.childIndexes.map(index => scopes[index]);
    scope.variables = record.variableIndexes.map(index => variables[index]);
    scope.references = record.referenceRecords.map(([nodeId, variableIndex]) => ({
      identifier: ast[nodeId],
      resolved: variables[variableIndex],
    }));
    // Scope IDs belong to scope-introducing block nodes, so the scope record
    // already contains both values needed to restore them without an N-node array.
    if (record.scopeId !== undefined) scope.block.scopeId = record.scopeId;
  }
  for (let i = 0; i < ast.length; i++) {
    const node = ast[i];
    const parent = node.parentNode;
    node.scope = scopes[snapshot.scopeIndexes[i]];
    // Basic parsing already proved the same preorder parent structure. Rebuild
    // these derived arrays directly instead of retaining them in the snapshot.
    node.ancestry = parent ? [...parent.ancestry, parent.nodeId] : [];
    node.lineage = parent ? [...parent.lineage] : [];
    // A node either inherits its parent's scope or enters one new child scope.
    // Identity avoids rescanning the lineage array for every restored node.
    if (!parent || node.scope !== parent.scope) node.lineage.push(node.scope.scopeId);
  }
  const declarations = snapshot.declarations;
  if (snapshot.declarationsArePacked) {
    for (let i = 0; i < declarations.length; i += 2) {
      const node = ast[declarations[i]];
      node.declNode = ast[declarations[i + 1]];
      // Packed records were captured in preorder, so rebuilding the inverse
      // array with push() also preserves public reference order.
      node.declNode.references.push(node);
    }
  } else {
    // Identifier-heavy programs use fewer integers in a dense node-indexed
    // array than in two-integer records for every resolved reference.
    for (let i = 0; i < declarations.length; i++) {
      if (declarations[i] === -1) continue;
      ast[i].declNode = ast[declarations[i]];
      ast[i].declNode.references.push(ast[i]);
    }
  }
  ast[0].allScopes = Object.fromEntries(snapshot.allScopeEntries.map(([scopeId, index]) => [scopeId, scopes[index]]));
  return true;
}

/**
 * Detect whether an AST retains raw eslint-scope detail rather than projection.
 *
 * Compact scopes intentionally omit `set` and `through`; checking the root
 * scope avoids trusting constructor options when an Arborist was built from an
 * existing flat AST.
 *
 * @example
 * hasFullDetailedScopes(generateFlatAST('let value;', {compactScopes: false})); // true
 * hasFullDetailedScopes(generateFlatAST('let value;', {compactScopes: true})); // false
 *
 * @param {ASTNode[]} ast Flat AST to inspect.
 * @return {boolean} Whether full detailed scope objects are already present.
 */
function hasFullDetailedScopes(ast) {
  const rootScope = ast[0]?.allScopes?.[0] || Object.values(ast[0]?.allScopes || {})[0];
  return Boolean(rootScope && ('set' in rootScope || 'through' in rootScope));
}

/**
 * Queue AST deletions and replacements, then regenerate and validate them once.
 *
 * markNode(), replaceNode(), and deleteNode() do not update source or rebuild
 * metadata. applyChanges() performs that work for the complete batch.
 *
 * @example
 * const arborist = new Arborist('const answer = 41;');
 * const literal = arborist.ast[0].typeMap.Literal[0];
 * arborist.replaceNode(literal, {type: 'Literal', value: 42});
 * arborist.script; // Still 'const answer = 41;'
 * arborist.applyChanges();
 * arborist.script; // 'const answer = 42;'
 */
/**
 * Thrown when an armed modifier mark cap is reached.
 *
 * applyIteratively treats this as an early stop, not a modifier failure.
 */
export class ModifierRunLimitError extends Error {
  /**
   * @param {string} [limitName='maxMarkedNodes'] Limit that stopped the modifier.
   */
  constructor(limitName = 'maxMarkedNodes') {
    super(`Modifier stopped after reaching ${limitName}.`);
    this.name = 'ModifierRunLimitError';
    this.limitName = limitName;
  }
}

export class Arborist {
  /**
   * Create a mutation queue from source or an existing flat AST.
   *
   * @example
   * const fromSource = new Arborist('let value = 1;', {compactScopes: true});
   * const fromAst = new Arborist(fromSource.ast);
   * // Existing AST input is preserved; options govern later rebuilds.
   *
   * @param {string|ASTNode[]} scriptOrFlatAstArr The target script or a flat AST array.
   * @param {GenerateFlatASTOptions} [options] Flat AST generation options used for construction and rebuilds.
   */
  constructor(scriptOrFlatAstArr, options = {}) {
    if (shouldUseNextMajorDefaults(options.nextMajorDefaults)) {
      options = {compactScopes: true, retainTokens: false, ...options};
    }
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
	 * Promote a deletion to the nearest parent that can be removed validly.
   *
   * For example, deleting the operand from `value++;` targets the complete
   * ExpressionStatement; deleting a sole `if` branch queues an EmptyStatement
   * because the consequent property cannot be absent.
   *
   * @example
   * const identifier = arborist.ast[0].typeMap.Identifier[0];
   * arborist._getCorrectTargetForDeletion(identifier).type; // 'ExpressionStatement'
   *
	 * @param {ASTNode} startNode Originally requested deletion target.
	 * @return {ASTNode} Node that can be removed or replaced without invalid syntax.
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
          // A replacement leaves its declarator present, so only siblings
          // actually queued for deletion make the declaration removable.
          if (declaration !== currentNode && !declaration.isMarkedForDeletion) {
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
   * Return the number of currently queued changes.
   *
   * @example
   * arborist.replaceNode(first, replacement);
   * arborist.deleteNode(second);
   * arborist.getNumberOfChanges(); // 2
   *
	 * @returns {number} Queued replacement and deletion count.
	 */
  getNumberOfChanges() {
    return this.replacements.length + this.markedForDeletion.length;
  }

  /**
   * Snapshot script, options, and queued marks as node IDs. The AST is omitted
   * because the same script and options rebuild the same node IDs.
   *
   * @example
   * const snapshot = arborist.serialize();
   * const restored = Arborist.deserialize(snapshot);
   * restored.script === arborist.script;
   *
   * @return {{script: string, options: object, replacements: Array<[number, object]>, markedForDeletion: number[]}}
   *   Cloneable session state.
   */
  serialize() {
    return {
      script: this.script,
      options: {...this.options},
      replacements: this.replacements.map(([node, replacement]) => [node.nodeId, replacement]),
      markedForDeletion: [...this.markedForDeletion],
    };
  }

  /**
   * Rebuild an Arborist from {@link serialize} by parsing the script and
   * re-marking the stored node IDs.
   *
   * @example
   * Arborist.deserialize(arborist.serialize()).getNumberOfChanges();
   *
   * @param {{script: string, options?: object, replacements?: Array<[number, object]>, markedForDeletion?: number[]}} snapshot
   *   Payload produced by {@link serialize}.
   * @return {Arborist} New session with the same script and queued marks.
   */
  static deserialize(snapshot) {
    if (!snapshot || typeof snapshot.script !== 'string') {
      throw new TypeError('Arborist snapshot must include a script string.');
    }
    const arborist = new Arborist(snapshot.script, snapshot.options || {});
    const replacements = snapshot.replacements || [];
    for (let i = 0; i < replacements.length; i++) {
      const [nodeId, replacement] = replacements[i];
      const node = arborist.ast[nodeId];
      if (node) arborist.markNode(node, replacement);
    }
    const deletions = snapshot.markedForDeletion || [];
    for (let i = 0; i < deletions.length; i++) {
      const node = arborist.ast[deletions[i]];
      if (node) arborist.markNode(node);
    }
    return arborist;
  }

  /**
	 * Queue a replacement when replacementNode exists, otherwise queue a deletion.
   *
   * A node is ignored when it or one of its ancestors is already marked,
   * preventing overlapping changes from being applied twice.
   *
   * @example
   * arborist.markNode(identifier, {type: 'Identifier', name: 'renamed'});
   * arborist.markNode(statement); // Queues deletion.
   *
	 * @param {ASTNode} targetNode The node to replace or remove.
	 * @param {object|ASTNode} [replacementNode] Replacement node; omission means deletion.
	 * @return {void}
	 */
  markNode(targetNode, replacementNode) {
    let currentNode = targetNode;
    while (currentNode) {
      if (currentNode.isMarked) return;
      currentNode = currentNode.parentNode;
    }
    if (this._maxMarkedNodes !== undefined) {
      if (this._markedNodesCount >= this._maxMarkedNodes) {
        throw new ModifierRunLimitError('maxMarkedNodes');
      }
    }
    if (replacementNode) {  // Mark for replacement
      this.replacements.push([targetNode, replacementNode]);
      targetNode.isMarked = true;
      if (this._maxMarkedNodes !== undefined) this._markedNodesCount++;
      if (typeof this._onMark === 'function') this._onMark(targetNode.nodeId, replacementNode);
    } else {                // Mark for deletion
      targetNode = this._getCorrectTargetForDeletion(targetNode);
      if (!targetNode.parentNode) return;
      if (targetNode.isEmpty) this.markNode(targetNode, {type: 'EmptyStatement'});
      else if (!targetNode.isMarked) {
        if (this._maxMarkedNodes !== undefined) {
          if (this._markedNodesCount >= this._maxMarkedNodes) {
            throw new ModifierRunLimitError('maxMarkedNodes');
          }
          this._markedNodesCount++;
        }
        this.markedForDeletion.push(targetNode.nodeId);
        targetNode.isMarked = true;
        targetNode.isMarkedForDeletion = true;
        if (typeof this._onMark === 'function') this._onMark(targetNode.nodeId);
      }
    }
  }

  /**
	 * Queue a node replacement. This is equivalent to markNode(targetNode, replacementNode),
	 * but is clearer at the call site when you are only replacing nodes.
   *
   * @example
   * arborist.replaceNode(literal, {type: 'Literal', value: 42});
   *
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
   *
   * @example
   * arborist.deleteNode(unusedStatement);
   *
	 * @param {ASTNode} targetNode The node to delete.
	 * @return {void}
	 */
  deleteNode(targetNode) {
    return this.markNode(targetNode);
  }

  /**
	 * Merge comments from a source node into a target node or array.
   *
   * @example
   * Arborist.mergeComments(replacement, original, 'leadingComments');
   * // Existing replacement comments stay first; original comments follow.
   *
	 * @param {ASTNode|Object} target The node or array element to receive comments.
	 * @param {ASTNode} source The node whose comments should be merged.
	 * @param {'leadingComments'|'trailingComments'} which Comment collection to merge.
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
   * Materialize full eslint-scope metadata after compact editing is complete.
   *
   * The rebuild is prepared separately and swapped in only after it succeeds.
   * This keeps the compact AST usable if parsing or scope analysis fails.
   *
   * @example
   * const arborist = new Arborist('const value = 1;', {
   *   compactScopes: true,
   *   retainTokens: false,
   * });
   * arborist.finalizeScopes() === arborist; // true
   * 'set' in arborist.ast[0].allScopes[0]; // true
   *
   * @example
   * arborist.replaceNode(literal, replacement);
   * arborist.finalizeScopes(); // Throws: apply or clear queued changes first.
   *
   * @return {this} This Arborist with full detailed scopes.
   * @throws {Error} When changes are pending or a full rebuild fails.
   */
  finalizeScopes() {
    if (this.getNumberOfChanges() > 0) {
      throw new Error('Cannot finalize scopes while mutations are pending. Call applyChanges() first.');
    }
    if (!this.ast.length) throw new Error('Cannot finalize scopes for an empty AST.');

    const fullOptions = {...this.options, detailed: true, compactScopes: false};
    if (hasFullDetailedScopes(this.ast)) {
      // Future rebuilds must stay full even when constructor options did not
      // describe an existing AST accurately.
      this.options = fullOptions;
      return this;
    }

    const rootNode = this.ast[0];
    const sourceType = rootNode.sourceType;
    const script = this.script || rootNode.src || generateCode(rootNode);
    const fullAst = rebuildFlatAst(script, sourceType, fullOptions);
    if (!fullAst.length || !hasFullDetailedScopes(fullAst)) {
      throw new Error('Unable to finalize scopes from the current source.');
    }

    this.ast = fullAst;
    this.script = script;
    this.options = fullOptions;
    return this;
  }

  /**
	 * Apply the queued batch, generate source, and rebuild a validated flat AST.
	 *
   * Invalid generated source restores the original AST and returns zero.
   * Successful application clears the queues and preserves the invariant
   * `this.ast[node.nodeId] === node`.
   *
   * @example
   * arborist.replaceNode(literal, {type: 'Literal', value: 42});
   * arborist.applyChanges(); // 1
   * arborist.getNumberOfChanges(); // 0
   *
   * @example
   * arborist.replaceNode(expression, {type: 'DefinitelyInvalid'});
   * arborist.applyChanges(); // 0; source and AST are restored.
	 *
	 * @return {number} The number of modifications made.
	 */
  applyChanges() {
    if (this.getNumberOfChanges() === 0) {
      // Preserve the public call counter while avoiding classification,
      // snapshots, and rollback closures for the common empty-queue check.
      ++this.appliedCounter;
      return 0;
    }
    let changesCounter = 0;
    let rootNode = this.ast[0];
    const originalSourceType = rootNode?.sourceType;
    // Raw eslint-scope objects retain old AST nodes and cannot be remapped
    // safely. Metadata reuse is therefore restricted to compact scopes.
    let canReuseDetailedMetadata = this.options.compactScopes === true && this.options.detailed !== false &&
      classifyMutationBatch(this.replacements, this.markedForDeletion) <= mutationImpact.expressionStructural;
    let metadataSnapshot = canReuseDetailedMetadata ? captureCompactMetadata(this.ast) : null;
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
      // The early return above makes this defensive guard effectively free,
      // while keeping the mutation phase explicitly conditional on its queue.
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
        // No parent container can reach the batching threshold when the
        // complete queue is smaller, so avoid allocating grouping maps.
          const batchedDeletionStates = this.markedForDeletion.length >= adjacentMutationMinimum ?
            buildBatchedDeletionStates(this.ast, this.markedForDeletion) : null;
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
                  const deletionState = batchedDeletionStates?.get(container);
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
          if (batchedDeletionStates) {
            for (const state of batchedDeletionStates.values()) {
              compactDeletedSlots(state.container);
              state.indexes.clear();
              state.previous = null;
              state.next = null;
            }
            batchedDeletionStates.clear();
          }
          const batchedReplacementIndexes = this.replacements.length >= adjacentMutationMinimum ?
            buildBatchedReplacementIndexes(this.replacements) : null;
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
                  const indexes = batchedReplacementIndexes?.get(container);
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
          if (batchedReplacementIndexes) {
            for (const indexes of batchedReplacementIndexes.values()) indexes.clear();
            batchedReplacementIndexes.clear();
          }
        }
      }
      if (changesCounter) {
        this.replacements.length = 0;
        this.markedForDeletion.length = 0;
        // Generation may reject structurally invalid replacements before any
        // new AST is allocated; the catch path restores the original source.
        const updatedSourceType = rootNode?.sourceType || originalSourceType;
        const script = generateCode(rootNode);
        // Code generation is the last operation that needs the mutated graph.
        // Replace the array as well as the root reference so its backing store
        // cannot remain allocated while the replacement AST is constructed.
        rootNode = null;
        this.ast = [];
        let ast;
        if (canReuseDetailedMetadata) {
          const basicOptions = {...this.options, detailed: false};
          if (canUseLeanBasicParse) {
            basicOptions.parseOpts = {...this.options.parseOpts, comment: false, tokens: false};
          }
          ast = rebuildFlatAst(script, updatedSourceType, basicOptions);
          const metadataWasApplied = ast.length && applyCompactMetadata(metadataSnapshot, ast);
          // The snapshot is single-use. Drop its remaining typed arrays and
          // compact records before any authoritative fallback allocation.
          metadataSnapshot = null;
          if (ast.length && !metadataWasApplied) {
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
