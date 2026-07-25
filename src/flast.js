import {parse, VisitorKeys} from 'espree';
import {analyze} from 'eslint-scope';
import {logger} from './utils/logger.js';
import {shouldUseNextMajorDefaults} from './utils/nextMajorDefaults.js';
import {generate, attachComments} from 'escodegen';

/** @import {ASTAllScopes, ASTNode, ASTRootNode, ASTTypeMap, GenerateCodeOptions, GenerateFlatASTOptions, ParseCodeOptions, ScopeVariableMapByScopeId} from './types.d.ts' */

const ecmaVersion = 'latest';
const currentYear = (new Date()).getFullYear();
const sourceType = 'module';

/**
 * Check whether source text may contain a comment syntax supported by Espree.
 *
 * This is deliberately a cheap conservative scan, not a tokenizer. A false
 * positive costs a richer parse; a false negative could discard comments.
 *
 * @example
 * mayContainComments('const url = "https://example.com";'); // true
 * mayContainComments('const answer = 42;'); // false
 *
 * @param {string} inputCode JavaScript source.
 * @return {boolean} Whether parsing may need comment and token arrays for attachment.
 */
function mayContainComments(inputCode) {
  // False positives inside strings or regular expressions only retain the
  // rich parse path. Cover hashbang and legacy script comments so this test
  // can never create a false negative that silently drops source comments.
  return inputCode.includes('//') || inputCode.includes('/*') || inputCode.includes('#!') ||
    inputCode.includes('<!--') || inputCode.includes('-->');
}

/**
 * Parse JavaScript into an ESTree root and attach comments when tokens exist.
 *
 * Unlike generateRootNode(), this low-level helper lets Espree parse errors
 * escape and does not retry with another source type.
 *
 * @example
 * const root = parseCode('/* header *\/ const value = 1;', {
 *   sourceType: 'module',
 *   comment: true,
 *   tokens: true,
 * });
 * root.type; // 'Program'
 * root.body[0].leadingComments[0].value; // ' header '
 *
 * @param {string} inputCode JavaScript source to parse.
 * @param {ParseCodeOptions} [opts] Additional Espree options.
 * @return {ASTRootNode} Parsed ESTree program.
 */
function parseCode(inputCode, opts = {}) {
  const rootNode = parse(inputCode, {ecmaVersion, comment: true, range: true, ...opts});
  if (rootNode.tokens) attachComments(rootNode, rootNode.comments, rootNode.tokens);
  return rootNode;
}

const excludedParentKeys = new Set([
  'type', 'start', 'end', 'range', 'sourceType', 'comments', 'srcClosure', 'nodeId', 'leadingComments', 'trailingComments',
  'childNodes', 'parentNode', 'parentKey', 'scope', 'typeMap', 'lineage', 'ancestry', 'allScopes', 'tokens',
]);

const generateFlatASTDefaultOptions = {
  // Scope analysis dominates detailed parsing on large programs. Disable it
  // when callers only need structural traversal.
  detailed: true,
  // Source slices improve inspection but retain one string per AST node.
  includeSrc: true,
  // Tokens are only needed temporarily for comment attachment unless callers
  // explicitly inspect the root token stream.
  retainTokens: true,
  // Compact scopes discard eslint-scope internals while preserving flAST's
  // documented declaration/reference relationships.
  compactScopes: false,
  // Script retry supports sloppy-mode input such as `with` statements.
  alternateSourceTypeOnFailure: true,
  // These may be overridden for JSX, a fixed ECMA version, or script parsing.
  parseOpts: {
    sourceType,
    comment: true,
    tokens: true,
  },
};

/**
 * Merge current defaults, the optional future preset, and explicit overrides.
 *
 * Explicit options are applied last so the preview never prevents callers
 * from retaining tokens or selecting another supported behavior.
 *
 * @example
 * resolveGenerateFlatASTOptions({nextMajorDefaults: true}).retainTokens; // false
 * resolveGenerateFlatASTOptions({nextMajorDefaults: true, retainTokens: true}).retainTokens; // true
 *
 * @param {GenerateFlatASTOptions} [opts] Caller-provided options.
 * @return {GenerateFlatASTOptions} Fully resolved options.
 */
function resolveGenerateFlatASTOptions(opts = {}) {
  const futureDefaults = shouldUseNextMajorDefaults(opts.nextMajorDefaults) ?
    {retainTokens: false} : null;
  return {...generateFlatASTDefaultOptions, ...futureDefaults, ...opts};
}

/**
 * Parse source into a preorder flat AST.
 *
 * Every returned node obeys `ast[node.nodeId] === node`, so callers can store
 * node relationships as compact numeric IDs and resolve them by array access.
 * Invalid source returns an empty array.
 *
 * @example
 * const ast = generateFlatAST('const answer = 42;');
 * ast[0].type; // 'Program'
 * ast.every((node, index) => node.nodeId === index); // true
 * ast[0].typeMap.Literal[0].value; // 42
 *
 * @example
 * const structuralAst = generateFlatAST('const answer = 42;', {
 *   detailed: false,
 *   includeSrc: false,
 *   retainTokens: false,
 * });
 * structuralAst[0].allScopes; // undefined
 *
 * @param {string} inputCode JavaScript source to flatten.
 * @param {GenerateFlatASTOptions} [opts] Parsing, metadata, and retention options.
 * @return {ASTNode[]} Flat AST, or an empty array when parsing fails.
 */
function generateFlatAST(inputCode, opts = {}) {
  opts = resolveGenerateFlatASTOptions(opts);
  let tree = [];
  const rootNode = generateRootNode(inputCode, opts);
  if (rootNode) {
    tree = extractNodesFromRoot(rootNode, opts);
  }
  return tree;
}

const generateCodeDefaultOptions = {
  format: {
    indent: {
      style: '  ',
      adjustMultilineComment: true,
    },
    quotes: 'auto',
    escapeless: true,
    compact: false,
  },
  comment: true,
};

/**
 * Generate JavaScript source from an ESTree node.
 *
 * All Escodegen options are accepted. flAST defaults to two-space indentation,
 * automatic quote selection, readable output, and preserved comments.
 *
 * @example
 * const root = generateRootNode('const answer = 42;');
 * generateCode(root); // 'const answer = 42;'
 *
 * @example
 * generateCode(root, {format: {compact: true}}); // 'const answer=42;'
 *
 * @param {ASTNode} rootNode ESTree node to generate.
 * @param {GenerateCodeOptions} [opts] Escodegen formatting and source-map options.
 * @return {string} Generated JavaScript source.
 */
function generateCode(rootNode, opts = {}) {
  return generate(rootNode, {...generateCodeDefaultOptions, ...opts});
}

/**
 * Parse source with flAST's retention and source-type fallback behavior.
 *
 * Module parsing is attempted first by default. If it fails, script parsing is
 * attempted so valid sloppy-mode programs remain usable. Both failures return
 * null rather than throwing.
 *
 * @example
 * generateRootNode('export const value = 1;').sourceType; // 'module'
 * generateRootNode('with (target) { read(); }').sourceType; // 'script'
 * generateRootNode('const = ;'); // null
 *
 * @param {string} inputCode JavaScript source to parse.
 * @param {GenerateFlatASTOptions} [opts] Parsing and metadata-retention options.
 * @return {ASTRootNode|null} Parsed root, or null when no configured parse succeeds.
 */
function generateRootNode(inputCode, opts = {}) {
  opts = resolveGenerateFlatASTOptions(opts);
  let parseOpts = opts.parseOpts || {};
  if (!opts.retainTokens && !mayContainComments(inputCode)) {
    // Comment attachment is the only reason a token stream is needed here.
    // Avoiding both arrays reduces parse work and transient memory together.
    parseOpts = {...parseOpts, comment: false, tokens: false};
  }
  let rootNode = null;
  try {
    rootNode = parseCode(inputCode, parseOpts);
    if (opts.includeSrc) rootNode.src = inputCode;
    if (!opts.retainTokens) delete rootNode.tokens;
  } catch (e) {
    // If any parse error occurs and alternateSourceTypeOnFailure is set, try 'script' mode
    if (opts.alternateSourceTypeOnFailure) {
      try {
        rootNode = parseCode(inputCode, {...parseOpts, sourceType: 'script'});
        if (opts.includeSrc) rootNode.src = inputCode;
        if (!opts.retainTokens) delete rootNode.tokens;
      } catch (e2) {
        logger.debug('Failed to parse as module and script:', e, e2);
      }
    } else {
      logger.debug(e);
    }
  }
  return rootNode;
}

/**
 * Decorate one node for flat traversal and assign its stable array index.
 *
 * @example
 * const indexed = indexNode(options, rootNode, scopes, 12, node);
 * indexed.nodeId; // 12
 * indexed.childNodes.every(child => child.parentNode === indexed); // true
 *
 * @param {GenerateFlatASTOptions} opts Active flat-AST options.
 * @param {ASTRootNode} rootNode Program root containing the original source.
 * @param {ASTAllScopes} scopes Scopes indexed by flAST scope ID.
 * @param {number} nodeId Node's destination index in the flat AST.
 * @param {ASTNode} node Node to decorate.
 * @return {ASTNode} Decorated node.
 */
function indexNode(opts, rootNode, scopes, nodeId, node) {
  const children = [];
  let childrenAreOrdered = true;
  let previousStart = -1;
  // Child nodes already receive parentKey while their parent is indexed.
  // Only the root or a standalone custom node needs the default property.
  if (node.parentKey === undefined) node.parentKey = '';
  // Known ESTree nodes use VisitorKeys to avoid scanning metadata. Reflective
  // discovery keeps custom parser node types traversable.
  const visitorKeys = VisitorKeys[node.type];
  const keys = visitorKeys || Object.keys(node);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!visitorKeys && excludedParentKeys.has(key)) continue;
    const content = node[key];
    if (content && typeof content === 'object') {
      // Parent links are assigned before traversal so descendants can inherit
      // ancestry, lineage, and scope data when they are indexed.
      if (Array.isArray(content)) {
        for (let j = 0; j < content.length; j++) {
          const childNode = content[j];
          if (!childNode || typeof childNode.type !== 'string') continue;
          childNode.parentNode = node;
          childNode.parentKey = key;
          if (childNode.start < previousStart) childrenAreOrdered = false;
          previousStart = childNode.start;
          children.push(childNode);
        }
      } else if (typeof content.type === 'string') {
        content.parentNode = node;
        content.parentKey = key;
        if (content.start < previousStart) childrenAreOrdered = false;
        previousStart = content.start;
        children.push(content);
      }
    }
  }
  // Preserve nodes that share a source offset, such as shorthand property keys
  // and values. Most ESTree fields are already in source order, so only sort
  // the uncommon out-of-order case.
  node.childNodes = childrenAreOrdered ? children : children.sort((a, b) => a.start - b.start);

  node.nodeId = nodeId;
  if (opts.detailed) {
    node.ancestry = [...node.parentNode?.ancestry || []];
    if (node.parentNode) node.ancestry.push(node.parentNode.nodeId);
    node.scope = scopes[node.scopeId] || node.parentNode?.scope;
    node.lineage = [...node.parentNode?.lineage || []];
    if (!node.lineage.includes(node.scope.scopeId)) {
      node.lineage.push(node.scope.scopeId);
    }
  }
  // Avoid using a getter with a closure around source here, as the
  // memory requirement for a function per node is far greater than using
  // a string reference for sufficiently large AST Trees
  // (~2.4 nodes for 3 Gib).
  if (opts.includeSrc && !node.src)
    node.src = rootNode.src.substring(node.start, node.end);
  return node;
}

/**
 * Link identifier declarations and references after every node is indexed.
 *
 * @example
 * linkIdentifierRelations(root.typeMap, root.allScopes);
 * declaration.references[0] === reference; // true
 * reference.declNode === declaration; // true
 *
 * @param {ASTTypeMap} typeMap Nodes grouped by ESTree type.
 * @param {ASTAllScopes} scopes Scopes indexed by flAST scope ID.
 * @return {void}
 */
function linkIdentifierRelations(typeMap, scopes) {
  const identifiers = typeMap.Identifier || [];
  const referenceDeclMap = new Map();
  const scopeVarMaps = buildScopeVarMaps(scopes, referenceDeclMap);
  for (let i = 0; i < identifiers.length; i++) {
    mapIdentifierRelations(identifiers[i], scopeVarMaps, referenceDeclMap);
  }
}

/**
 * Replace eslint-scope's internal graph with the documented subset used by flAST.
 *
 * @example
 * const compact = compactScopeGraph(rawScopes);
 * compact[0].variables[0]; // {name, identifiers}
 * compact[0].through; // undefined: undocumented eslint-scope internals are removed.
 *
 * @param {ASTAllScopes} scopes Raw scopes indexed by flAST scope ID.
 * @return {ASTAllScopes} Compact scopes preserving public links and object identity.
 */
function compactScopeGraph(scopes) {
  // The raw scope graph remains strongly reachable throughout projection, so
  // weak keys cannot be collected here. Plain maps have cheaper hot lookups
  // and are explicitly cleared before returning the compact graph.
  const projectedScopes = new Map();
  const projectedVariables = new Map();
  /**
   * Project an eslint-scope variable into flAST's documented representation.
   *
   * Repeated projection returns the same object because scope references and
   * variable lists must agree by identity.
   *
   * @example
   * projectVariable(variable) === projectVariable(variable); // true
   *
   * @param {object|null|undefined} variable eslint-scope variable.
   * @return {object|null|undefined} Compact variable projection.
   */
  const projectVariable = variable => {
    if (!variable) return variable;
    let projected = projectedVariables.get(variable);
    if (!projected) {
      projected = {name: variable.name, identifiers: variable.identifiers || []};
      projectedVariables.set(variable, projected);
    }
    return projected;
  };

  const rawScopes = [];
  const pendingScopes = Object.values(scopes);
  while (pendingScopes.length) {
    const scope = pendingScopes.pop();
    if (!scope || projectedScopes.has(scope)) continue;
    rawScopes.push(scope);
    projectedScopes.set(scope, {
      block: scope.block,
      childScopes: [],
      scopeId: scope.scopeId,
      type: scope.type,
      upper: null,
      variables: [],
      references: [],
    });
    // Excluded module/function-name scopes can still participate in public
    // upper and variableScope relationships, so project the reachable graph.
    if (scope.upper) pendingScopes.push(scope.upper);
    if (scope.variableScope) pendingScopes.push(scope.variableScope);
    for (let i = 0; i < scope.childScopes.length; i++) pendingScopes.push(scope.childScopes[i]);
  }

  for (let i = 0; i < rawScopes.length; i++) {
    const scope = rawScopes[i];
    const projected = projectedScopes.get(scope);
    projected.upper = projectedScopes.get(scope.upper) || null;
    projected.variableScope = projectedScopes.get(scope.variableScope);
    projected.childScopes = (scope.childScopes || []).map(child => projectedScopes.get(child));
    projected.variables = (scope.variables || []).map(projectVariable);
    projected.references = (scope.references || []).map(reference => ({
      identifier: reference.identifier,
      resolved: projectVariable(reference.resolved),
    }));
  }

  const compactScopes = {};
  for (const scopeId in scopes) compactScopes[scopeId] = projectedScopes.get(scopes[scopeId]);
  scopes[0].block.allScopes = compactScopes;
  projectedScopes.clear();
  projectedVariables.clear();
  return compactScopes;
}

/**
 * Flatten and decorate an already parsed ESTree program.
 *
 * Traversal is iterative so deeply nested or very large programs cannot
 * overflow the JavaScript call stack.
 *
 * @example
 * const root = parseCode('function run() { return 1; }', {sourceType: 'module'});
 * const ast = extractNodesFromRoot(root);
 * ast[0] === root; // true
 * ast.every((node, index) => node.nodeId === index); // true
 *
 * @param {ASTRootNode} rootNode Parsed ESTree program.
 * @param {GenerateFlatASTOptions} [opts] Metadata and source-retention options.
 * @param {Record<string, number>} [phaseTimings] Internal benchmark timings.
 * @return {ASTNode[]} Decorated nodes in preorder traversal order.
 */
function extractNodesFromRoot(rootNode, opts, phaseTimings) {
  opts = {...generateFlatASTDefaultOptions, ...opts};
  const typeMap = {typeList: []};
  const allNodes = [];
  let startedAt = phaseTimings ? performance.now() : 0;
  let scopes = opts.detailed ? getAllScopes(rootNode) : {};
  // Project before traversal so every node receives its final compact scope
  // directly; remapping every node afterward was measurably slower.
  if (opts.detailed && opts.compactScopes) scopes = compactScopeGraph(scopes);
  if (phaseTimings) {
    phaseTimings.scopeAnalysis = performance.now() - startedAt;
    startedAt = performance.now();
  }

  const parents = [];
  const nextChildIndexes = [];
  let visitor = rootNode;
  while (visitor) {
    allNodes.push(indexNode(opts, rootNode, scopes, allNodes.length, visitor));
    if (!typeMap[visitor.type]) {
      typeMap[visitor.type] = [];
      typeMap.typeList.push(visitor.type);
    }
    typeMap[visitor.type].push(visitor);

    let childIndex = 0;
    while (childIndex < visitor.childNodes.length && visitor.childNodes[childIndex].childNodes) childIndex++;
    if (childIndex < visitor.childNodes.length) {
      parents.push(visitor);
      nextChildIndexes.push(childIndex + 1);
      visitor = visitor.childNodes[childIndex];
      continue;
    }

    visitor = null;
    while (parents.length) {
      const parentIndex = parents.length - 1;
      const parent = parents[parentIndex];
      const nextChildIndex = nextChildIndexes[parentIndex];
      if (nextChildIndex < parent.childNodes.length) {
        nextChildIndexes[parentIndex] = nextChildIndex + 1;
        const child = parent.childNodes[nextChildIndex];
        if (!child.childNodes) {
          visitor = child;
          break;
        }
      } else {
        parents.pop();
        nextChildIndexes.pop();
      }
    }
  }
  if (phaseTimings) {
    phaseTimings.flatteningAndDecoration = performance.now() - startedAt;
    startedAt = performance.now();
  }

  if (opts.detailed) linkIdentifierRelations(typeMap, scopes);
  if (phaseTimings) {
    phaseTimings.identifierLinking = performance.now() - startedAt;
  }
  if (allNodes?.length) {
    allNodes[0].typeMap = new Proxy(typeMap, {
      /**
       * Return an empty list for node types absent from this program.
       *
       * @example
       * root.typeMap.Identifier; // [] when the program has no identifiers.
       *
       * @param {ASTTypeMap} target Underlying type map.
       * @param {string|symbol} prop Requested property.
       * @param {object} receiver Proxy receiver.
       * @return {ASTNode[]|string[]} Stored value or a fresh empty array.
       */
      get(target, prop, receiver) {
        if (prop in target) {
          return Reflect.get(target, prop, receiver);
        }
        return [];	// Return an empty array for any undefined type
      },
    });
  }
  return allNodes;
}

/**
 * Precompute a map of variable names to declarations for each scope for fast lookup.
 *
 * @example
 * const maps = buildScopeVarMaps(root.allScopes);
 * maps[functionScopeId].parameter.identifiers[0].name; // 'parameter'
 *
 * @param {ASTAllScopes} scopes Scopes indexed by flAST scope ID.
 * @param {Map<object, ASTNode[]>} [referenceDeclMap] Optional direct reference-to-declaration cache.
 * @return {ScopeVariableMapByScopeId} Variable-name map for each scope ID.
 */
function buildScopeVarMaps(scopes, referenceDeclMap) {
  const scopeVarMaps = {};
  for (const scopeId in scopes) {
    const scope = scopes[scopeId];
    const varMap = {};
    for (let i = 0; i < scope.variables.length; i++) {
      const v = scope.variables[i];
      varMap[v.name] = v;
    }
    if (referenceDeclMap) {
      for (let i = 0; i < scope.references.length; i++) {
        const reference = scope.references[i];
        referenceDeclMap.set(reference.identifier, reference.resolved?.identifiers || []);
      }
    }
    scopeVarMaps[scopeId] = varMap;
  }
  return scopeVarMaps;
}

/**
 * Find declaration nodes resolved for a named scope reference.
 *
 * @example
 * findDeclarationNodes(scope.references, 'answer'); // [identifierNode]
 * findDeclarationNodes(scope.references, 'missing'); // undefined
 *
 * @param {object[]} references Scope reference records.
 * @param {string} name Identifier name to resolve.
 * @return {ASTNode[]|undefined} Resolved declaration identifiers, if recorded.
 */
function findDeclarationNodes(references, name) {
  for (let i = 0; i < references.length; i++) {
    if (references[i].identifier.name === name) return references[i].resolved?.identifiers || [];
  }
  return undefined;
}

/**
 * Attach bidirectional declaration/reference links to one Identifier.
 *
 * Non-computed member properties and object keys are intentionally ignored:
 * in `object.property`, `property` is a name, not a variable reference.
 *
 * @example
 * mapIdentifierRelations(reference, scopeVarMaps);
 * reference.declNode === declaration; // true
 * declaration.references.includes(reference); // true
 *
 * @example
 * // No link is created for `property` here.
 * const value = object.property;
 *
 * @param {ASTNode} node Candidate identifier node.
 * @param {ScopeVariableMapByScopeId} scopeVarMaps Variables indexed by scope and name.
 * @param {Map<object, ASTNode[]>} [referenceDeclMap] Optional direct resolution cache.
 * @return {void}
 */
function mapIdentifierRelations(node, scopeVarMaps, referenceDeclMap) {
  // Computed properties such as object[property] remain real references;
  // only syntactic names in object.property and `{property: value}` are skipped.
  if (node.type === 'Identifier' && !(!node.parentNode.computed && ['property', 'key'].includes(node.parentKey))) {
    const scope = node.scope;
    const varMap = scope && scopeVarMaps ? scopeVarMaps[scope.scopeId] : undefined;
    const variable = varMap ? varMap[node.name] : undefined;
    if (node.parentKey === 'id' || variable?.identifiers?.includes(node)) {
      node.references = node.references || [];
    } else {
      // Find declaration by finding the closest declaration of the same name.
      let decls = [];
      const directDecls = referenceDeclMap?.get(node);
      if (directDecls !== undefined) {
        decls = directDecls;
      } else if (variable) {
        decls = variable.identifiers || [];
      } else if (scope) {
        const scopeDecls = findDeclarationNodes(scope.references || [], node.name);
        if (scopeDecls !== undefined) {
          decls = scopeDecls;
        } else if (scope.variableScope && scope.variableScope !== scope) {
          decls = findDeclarationNodes(scope.variableScope.references || [], node.name) || [];
        }
      }
      let declNode = decls[0];
      if (decls.length > 1) {
        let commonAncestors = maxSharedLength(declNode.lineage, node.lineage);
        for (let i = 1; i < decls.length; i++) {
          const ca = maxSharedLength(decls[i].lineage, node.lineage);
          if (ca > commonAncestors) {
            commonAncestors = ca;
            declNode = decls[i];
          }
        }
      }
      if (declNode) {
        declNode.references = declNode.references || [];
        declNode.references.push(node);
        node.declNode = declNode;
      }
    }
  }
}

/**
 * Count the common prefix shared by two scope-lineage arrays.
 *
 * @example
 * maxSharedLength([0, 2, 5], [0, 2, 8]); // 2
 * maxSharedLength([0], [1]); // 0
 *
 * @param {number[]} targetArr First lineage.
 * @param {number[]} containedArr Second lineage.
 * @return {number} Number of equal entries before the first difference.
 */
function maxSharedLength(targetArr, containedArr) {
  let count = 0;
  for (let i = 0; i < containedArr.length; i++) {
    if (targetArr[i] !== containedArr[i]) break;
    ++count;
  }
  return count;
}

/**
 * Analyze and normalize every scope reachable from a program.
 *
 * Module and function-name wrapper scopes are folded out of the public
 * scope-ID map, while their variables and reachable relationships are retained.
 *
 * @example
 * const root = parseCode('export const value = 1;', {sourceType: 'module'});
 * const scopes = getAllScopes(root);
 * scopes[0].block === root; // true
 * root.allScopes === scopes; // true
 *
 * @param {ASTRootNode} rootNode Parsed ESTree program.
 * @return {ASTAllScopes} Normalized scopes indexed by consecutive scope IDs.
 */
function getAllScopes(rootNode) {
  // noinspection JSCheckFunctionSignatures
  const globalScope = analyze(rootNode, {
    optimistic: true,
    ecmaVersion: currentYear,
    sourceType}).acquireAll(rootNode)[0];
  const globalVariables = new Set(globalScope.variables);
  let scopeId = 0;
  const allScopes = {};
  const stack = [globalScope];
  while (stack.length) {
    const scope = stack.pop();
    if (scope.type !== 'module' && !scope.type.includes('-name')) {
      scope.scopeId = scopeId++;
      scope.block.scopeId = scope.scopeId;
      allScopes[scope.scopeId] = allScopes[scope.scopeId] || scope;

      for (let i = 0; i < scope.variables.length; i++) {
        const v = scope.variables[i];
        for (let j = 0; j < v.identifiers.length; j++) {
          v.identifiers[j].scope = scope;
          v.identifiers[j].references = [];
        }
      }
    } else if (scope.upper === globalScope && scope.variables?.length) {
      // A single global scope is enough, so if there are variables in a module scope, add them to the global scope
      for (let i = 0; i < scope.variables.length; i++) {
        const v = scope.variables[i];
        if (!globalVariables.has(v)) {
          globalVariables.add(v);
          globalScope.variables.push(v);
        }
      }
    }
    for (let i = scope.childScopes.length - 1; i >= 0; i--) {
      stack.push(scope.childScopes[i]);
    }
  }
  return rootNode.allScopes = allScopes;
}

export {
  extractNodesFromRoot,
  generateCode,
  generateFlatAST,
  generateRootNode,
  mapIdentifierRelations,
  parseCode,
};
