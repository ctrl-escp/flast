import {parse, VisitorKeys} from 'espree';
import {analyze} from 'eslint-scope';
import {logger} from './utils/logger.js';
import {generate, attachComments} from 'escodegen';

/** @import {ASTAllScopes, ASTNode, ASTRootNode, ASTTypeMap, GenerateCodeOptions, GenerateFlatASTOptions, ParseCodeOptions, ScopeVariableMapByScopeId} from './types.d.ts' */

const ecmaVersion = 'latest';
const currentYear = (new Date()).getFullYear();
const sourceType = 'module';

/**
 * Check whether source text may contain a comment syntax supported by Espree.
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
 * @param {string} inputCode
 * @param {ParseCodeOptions} [opts] Additional options for espree
 * @return {ASTRootNode} The root of the AST
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
  // If false, do not include any scope details
  detailed: true,
  // If false, do not include node src
  includeSrc: true,
  // If false, release parser tokens after comments have been attached
  retainTokens: true,
  // If true, retain only documented scope relationships after identifier linking
  compactScopes: false,
  // Retry to parse the code with sourceType: 'script' if 'module' failed with 'strict' error message
  alternateSourceTypeOnFailure: true,
  // Options for the espree parser
  parseOpts: {
    sourceType,
    comment: true,
    tokens: true,
  },
};

/**
 * @param {string} inputCode
 * @param {GenerateFlatASTOptions} [opts] Optional changes to behavior. See generateFlatASTDefaultOptions for available options.
 * @return {ASTNode[]} An array of flattened AST
 */
function generateFlatAST(inputCode, opts = {}) {
  opts = {...generateFlatASTDefaultOptions, ...opts};
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
 * @param {ASTNode} rootNode
 * @param {GenerateCodeOptions} [opts] Optional changes to behavior. See generateCodeDefaultOptions for available options.
 *        								             All escodegen options are supported, including sourceMap, sourceMapWithCode, etc.
 * @return {string} Code generated from AST
 */
function generateCode(rootNode, opts = {}) {
  return generate(rootNode, {...generateCodeDefaultOptions, ...opts});
}

/**
 * @param {string} inputCode
 * @param {GenerateFlatASTOptions} [opts]
 * @return {ASTRootNode|null}
 */
function generateRootNode(inputCode, opts = {}) {
  opts = {...generateFlatASTDefaultOptions, ...opts};
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
 * @param {GenerateFlatASTOptions} opts
 * @param {ASTRootNode} rootNode
 * @param {ASTAllScopes} scopes
 * @param {number} nodeId
 * @param {ASTNode} node
 * @return {ASTNode}
 */
function indexNode(opts, rootNode, scopes, nodeId, node) {
  const children = [];
  let childrenAreOrdered = true;
  let previousStart = -1;
  // Child nodes already receive parentKey while their parent is indexed.
  // Only the root or a standalone custom node needs the default property.
  if (node.parentKey === undefined) node.parentKey = '';
  // Iterate over all keys of the node to find child nodes
  const visitorKeys = VisitorKeys[node.type];
  const keys = visitorKeys || Object.keys(node);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (!visitorKeys && excludedParentKeys.has(key)) continue;
    const content = node[key];
    if (content && typeof content === 'object') {
      // Sort each child node by its start position
      // and set the parentNode and parentKey attributes
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
 * @param {ASTTypeMap} typeMap
 * @param {ASTAllScopes} scopes
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
 * @param {ASTAllScopes} scopes
 * @return {ASTAllScopes}
 */
function compactScopeGraph(scopes) {
  // The raw scope graph remains strongly reachable throughout projection, so
  // weak keys cannot be collected here. Plain maps have cheaper hot lookups
  // and are explicitly cleared before returning the compact graph.
  const projectedScopes = new Map();
  const projectedVariables = new Map();
  /**
   * Project an eslint-scope variable into flAST's documented representation.
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
 * @param {ASTRootNode} rootNode
 * @param {GenerateFlatASTOptions} [opts]
 * @param {Record<string, number>} [phaseTimings] Internal benchmark timings.
 * @return {ASTNode[]}
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
 * @param {ASTAllScopes} scopes
 * @param {Map<object, ASTNode[]>} [referenceDeclMap]
 * @return {ScopeVariableMapByScopeId} Map of scopeId to { [name]: variable }
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
 * @param {object[]} references
 * @param {string} name
 * @return {ASTNode[]|undefined}
 */
function findDeclarationNodes(references, name) {
  for (let i = 0; i < references.length; i++) {
    if (references[i].identifier.name === name) return references[i].resolved?.identifiers || [];
  }
  return undefined;
}

/**
 * @param {ASTNode} node
 * @param {ScopeVariableMapByScopeId} scopeVarMaps
 * @param {Map<object, ASTNode[]>} [referenceDeclMap]
 * @return {void}
 */
function mapIdentifierRelations(node, scopeVarMaps, referenceDeclMap) {
  // Track references and declarations
  // Prevent assigning declNode to member expression properties or object keys
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
 * @param {number[]} targetArr
 * @param {number[]} containedArr
 * @return {number} Return the maximum length of shared numbers
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
 * @param {ASTRootNode} rootNode
 * @return {ASTAllScopes}
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
