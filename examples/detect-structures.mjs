import {generateFlatAST} from '../src/index.js';

// This script includes a few patterns that are common in deobfuscation work.
const code = `
const alias = realTarget;
const fixedValue = 7;
console['log'](alias);
(function () {
  return alias;
})();
if (true) {
  const total = 1 + 2;
}
const arr = ['a', 'b', 'c'];
(function (targetArray, shifts) {
  while (shifts--) {
    targetArray.push(targetArray.shift());
  }
})(arr, 1);
`;

const ast = generateFlatAST(code);

function findProxyVariables() {
  // Match assignments that alias one identifier to another.
  return ast[0].typeMap.VariableDeclarator
    .filter((n) =>
      n.id?.type === 'Identifier' &&
      n.init?.type === 'Identifier' &&
      n.id.name !== n.init.name,
    )
    .map((n) => ({
      alias: n.id.name,
      target: n.init.name,
      src: n.src,
    }));
}

function findComputedMembers() {
  // Find property access written as obj['name'] instead of obj.name.
  return ast[0].typeMap.MemberExpression
    .filter((n) => n.computed)
    .map((n) => ({
      expression: n.src,
      property: n.property?.src,
    }));
}

function findWrapperIifes() {
  // Detect immediately invoked function expressions.
  return ast[0].typeMap.CallExpression
    .filter((n) =>
      n.callee?.type === 'FunctionExpression' ||
      n.callee?.type === 'ArrowFunctionExpression',
    )
    .map((n) => n.src);
}

function findFixedAssignedValues() {
  // Collect variables that are initialized with literal values.
  return ast[0].typeMap.VariableDeclarator
    .filter((n) => n.id?.type === 'Identifier' && n.init?.type === 'Literal')
    .map((n) => ({
      name: n.id.name,
      value: n.init.value,
      src: n.src,
    }));
}

function findDeterministicBinaryExpressions() {
  // These can often be folded safely because both sides are literals.
  return ast[0].typeMap.BinaryExpression
    .filter((n) => n.left?.type === 'Literal' && n.right?.type === 'Literal')
    .map((n) => n.src);
}

function findDeterministicIfStatements() {
  // Literal conditions are easy candidates for dead-code cleanup.
  return ast[0].typeMap.IfStatement
    .filter((n) => n.test?.type === 'Literal')
    .map((n) => n.src);
}

function findAugmentedArrayCandidates() {
  // This shape commonly appears in array-rotation obfuscation helpers.
  return ast[0].typeMap.CallExpression
    .filter((n) =>
      (
        n.callee?.type === 'FunctionExpression' ||
        n.callee?.type === 'ArrowFunctionExpression'
      ) &&
      n.arguments?.[0]?.type === 'Identifier' &&
      n.arguments?.[1]?.type === 'Literal' &&
      !Number.isNaN(Number(n.arguments[1].value)),
    )
    .map((n) => n.src);
}

// Print all matches in one pass so the structure checks stay easy to compare.
console.log({
  proxyVariables: findProxyVariables(),
  computedMembers: findComputedMembers(),
  wrapperIifes: findWrapperIifes(),
  fixedAssignedValues: findFixedAssignedValues(),
  deterministicBinaryExpressions: findDeterministicBinaryExpressions(),
  deterministicIfStatements: findDeterministicIfStatements(),
  augmentedArrayCandidates: findAugmentedArrayCandidates(),
});
