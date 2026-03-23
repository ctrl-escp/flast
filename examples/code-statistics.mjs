import {generateFlatAST} from '../src/index.js';

// Parse the script once and inspect the flat node list for quick metrics.
const code = `
function add() {
  const total = 1 + 2;
  return total;
}

if (true) {
  let count = 3;
  count++;
}
`;

const ast = generateFlatAST(code);
const scopeNodeCounts = {};

// Count how many nodes belong to each resolved scope.
for (const n of ast) {
  const scopeId = n.scope?.scopeId;
  if (scopeId !== undefined) {
    let scopeBlock = n.scope.block;
    // Display block scopes by the statement that introduced them when possible.
    if (scopeBlock.type === 'BlockStatement') scopeBlock = scopeBlock.parentNode;
    const scopeName = `${scopeId}-${scopeBlock.type}`;
    scopeNodeCounts[scopeName] = (scopeNodeCounts[scopeName] || 0) + 1;
  }
}

// typeList gives the unique node types found in the script.
console.log({
  totalNodes: ast.length,
  nodeTypes: ast[0].typeMap.typeList,
  numberOfDifferentTypes: ast[0].typeMap.typeList.length,
  numberOfScopes: Object.keys(ast[0].allScopes).length,
  nodesInEachScope: scopeNodeCounts,
  hasBinaryExpressions: ast[0].typeMap.typeList.includes('BinaryExpression'),
});
