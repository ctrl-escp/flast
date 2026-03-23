import {parse} from 'espree';
import {analyze} from 'eslint-scope';
import {logger} from './utils/logger.js';
import {generate, attachComments} from 'escodegen';

/** @import {ASTAllScopes, ASTNode, ASTRootNode, GenerateCodeOptions, GenerateFlatASTOptions, ParseCodeOptions, ScopeVariableMapByScopeId} from './types.d.ts' */

const ecmaVersion = 'latest';
const currentYear = (new Date()).getFullYear();
const sourceType = 'module';

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

const excludedParentKeys = [
  'type', 'start', 'end', 'range', 'sourceType', 'comments', 'srcClosure', 'nodeId', 'leadingComments', 'trailingComments',
  'childNodes', 'parentNode', 'parentKey', 'scope', 'typeMap', 'lineage', 'ancestry', 'allScopes', 'tokens',
];

const generateFlatASTDefaultOptions = {
  // If false, do not include any scope details
  detailed: true,
  // If false, do not include node src
  includeSrc: true,
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
  const parseOpts = opts.parseOpts || {};
  let rootNode = null;
  try {
    rootNode = parseCode(inputCode, parseOpts);
    if (opts.includeSrc) rootNode.src = inputCode;
  } catch (e) {
    // If any parse error occurs and alternateSourceTypeOnFailure is set, try 'script' mode
    if (opts.alternateSourceTypeOnFailure) {
      try {
        rootNode = parseCode(inputCode, {...parseOpts, sourceType: 'script'});
        if (opts.includeSrc) rootNode.src = inputCode;
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
function parseNode (opts, rootNode, scopes, nodeId, node) {
  if (node.nodeId !== undefined) return node;
  const childrenLoc = {}; // Store the location of child nodes to sort them by order
  node.parentKey = node.parentKey || '';	// Make sure parentKey exists
  // Iterate over all keys of the node to find child nodes
  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (excludedParentKeys.includes(key)) continue;
    const content = node[key];
    if (content && typeof content === 'object') {
      // Sort each child node by its start position
      // and set the parentNode and parentKey attributes
      if (Array.isArray(content)) {
        for (let j = 0; j < content.length; j++) {
          const childNode = content[j];
          if (!childNode) continue;
          childNode.parentNode = node;
          childNode.parentKey = key;
          childrenLoc[childNode.start] = childNode;
        }
      } else {
        content.parentNode = node;
        content.parentKey = key;
        childrenLoc[content.start] = content;
      }
    }
  }
  // Materialize children once to avoid spreading very large arrays into a call frame.
  node.childNodes = Object.values(childrenLoc);

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
 * @param {ASTRootNode} rootNode
 * @param {GenerateFlatASTOptions} [opts]
 * @return {ASTNode[]}
 */
function extractNodesFromRoot(rootNode, opts) {
  opts = {...generateFlatASTDefaultOptions, ...opts};
  const typeMap = {
    typeList: [],   // A quick way to get all the unique types of nodes that were parsed
  };
  const allNodes = [];
  const scopes = opts.detailed ? getAllScopes(rootNode) : {};

  let nodeId = 0;
  let visitor = rootNode;
  const lastParsed = {};
  while (visitor) {
    if(!visitor.childNodes){
      allNodes.push(parseNode(opts, rootNode, scopes, nodeId++, visitor));
      if (!typeMap[visitor.type]) {
        typeMap[visitor.type] = [];
        typeMap.typeList.push(visitor.type);
      }
      typeMap[visitor.type].push(visitor);
      lastParsed[visitor.nodeId] = 0;
    }
    const visitorId = visitor.nodeId;
    if(lastParsed[visitorId] < visitor.childNodes.length){
      visitor = visitor.childNodes[lastParsed[visitorId]++];
    }else{
      visitor = visitor.parentNode;
      delete lastParsed[visitorId];
    }
  }

  if (opts.detailed) {
    const identifiers = typeMap.Identifier || [];
    const scopeVarMaps = buildScopeVarMaps(scopes);
    for (let i = 0; i < identifiers.length; i++) {
      mapIdentifierRelations(identifiers[i], scopeVarMaps);
    }
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
 * @return {ScopeVariableMapByScopeId} Map of scopeId to { [name]: variable }
 */
function buildScopeVarMaps(scopes) {
  const scopeVarMaps = {};
  for (const scopeId in scopes) {
    const scope = scopes[scopeId];
    const varMap = {};
    for (let i = 0; i < scope.variables.length; i++) {
      const v = scope.variables[i];
      varMap[v.name] = v;
    }
    scopeVarMaps[scopeId] = varMap;
  }
  return scopeVarMaps;
}

/**
 * @param {ASTNode} node
 * @param {ScopeVariableMapByScopeId} scopeVarMaps
 */
function mapIdentifierRelations(node, scopeVarMaps) {
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
      if (variable) {
        decls = variable.identifiers || [];
      } else if (scope && (scope.references.length || scope.variableScope?.references.length)) {
        const references = [...(scope.references || []), ...(scope.variableScope?.references || [])];
        for (let i = 0; i < references.length; i++) {
          if (references[i].identifier.name === node.name) {
            decls = references[i].resolved?.identifiers || [];
            break;
          }
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
        if (!globalScope.variables.includes(v)) globalScope.variables.push(v);
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
