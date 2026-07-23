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

/**
 * Find declarations that simply alias another identifier.
 *
 * @example
 * findProxyVariables()[0].target; // 'realTarget'
 *
 * @return {Array<{alias: string, target: string, src: string}>} Alias records.
 */
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

/**
 * Find bracket-style member access such as `console['log']`.
 *
 * @example
 * findComputedMembers(); // [{expression: "console['log']", property: "'log'"}]
 *
 * @return {Array<{expression: string, property: string}>} Computed member records.
 */
function findComputedMembers() {
  // Find property access written as obj['name'] instead of obj.name.
  return ast[0].typeMap.MemberExpression
    .filter((n) => n.computed)
    .map((n) => ({
      expression: n.src,
      property: n.property?.src,
    }));
}

/**
 * Find calls whose callee is an inline function expression.
 *
 * @example
 * findWrapperIifes()[0].startsWith('(function ()'); // true
 *
 * @return {string[]} IIFE source snippets.
 */
function findWrapperIifes() {
  // Detect immediately invoked function expressions.
  return ast[0].typeMap.CallExpression
    .filter((n) =>
      n.callee?.type === 'FunctionExpression' ||
      n.callee?.type === 'ArrowFunctionExpression',
    )
    .map((n) => n.src);
}

/**
 * Find variables initialized directly from literals.
 *
 * @example
 * findFixedAssignedValues()[0].value; // 7
 *
 * @return {Array<{name: string, value: unknown, src: string}>} Fixed-value declarations.
 */
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

/**
 * Find binary expressions whose two operands are literals.
 *
 * @example
 * findDeterministicBinaryExpressions(); // ['1 + 2']
 *
 * @return {string[]} Foldable expression source snippets.
 */
function findDeterministicBinaryExpressions() {
  // These can often be folded safely because both sides are literals.
  return ast[0].typeMap.BinaryExpression
    .filter((n) => n.left?.type === 'Literal' && n.right?.type === 'Literal')
    .map((n) => n.src);
}

/**
 * Find if statements controlled directly by a literal.
 *
 * @example
 * findDeterministicIfStatements()[0].startsWith('if (true)'); // true
 *
 * @return {string[]} Deterministic if-statement source snippets.
 */
function findDeterministicIfStatements() {
  // Literal conditions are easy candidates for dead-code cleanup.
  return ast[0].typeMap.IfStatement
    .filter((n) => n.test?.type === 'Literal')
    .map((n) => n.src);
}

/**
 * Find calls shaped like common array-rotation helpers.
 *
 * @example
 * findAugmentedArrayCandidates()[0].endsWith('(arr, 1)'); // true
 *
 * @return {string[]} Candidate call source snippets.
 */
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
