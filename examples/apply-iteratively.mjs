import {applyIteratively} from '../src/index.js';

/**
 * Queue every numeric literal addition that is ready to be folded.
 *
 * @example
 * applyIteratively('const total = 1 + 2 + 3;', [foldConstantAddition]);
 * // const total = 6;
 *
 * @param {import('../src/types.d.ts').Arborist} arb Current mutation queue.
 * @return {import('../src/types.d.ts').Arborist} The same queue for applyIteratively.
 */
function foldConstantAddition(arb) {
  // Each pass folds only one binary layer, so repeated passes collapse chains.
  for (const n of arb.ast[0].typeMap.BinaryExpression) {
    if (
      n.operator === '+' &&
      n.left.type === 'Literal' &&
      n.right.type === 'Literal' &&
      typeof n.left.value === 'number' &&
      typeof n.right.value === 'number'
    ) {
      const value = n.left.value + n.right.value;
      arb.replaceNode(n, {
        type: 'Literal',
        value,
        raw: String(value),
      });
    }
  }

  return arb;
}

const source = 'const total = 1 + 2 + 3 + 4;';
// Keep iterating until no more constant additions remain.
const output = applyIteratively(source, [foldConstantAddition], 10);

console.log(output);
