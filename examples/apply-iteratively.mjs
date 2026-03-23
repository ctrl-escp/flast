import {applyIteratively} from '../src/index.js';

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
