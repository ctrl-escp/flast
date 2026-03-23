import {Arborist} from '../src/index.js';

// Arborist lets you queue replacements and deletions, then validate them together.
const source = `
const labels = ['drop', 'keep', 'drop'];
console.log('Hello' + ' ' + 'there!');
`;

const arb = new Arborist(source);
const replacements = {
  Hello: 'General',
  'there!': 'Kenobi',
};

// Replace some literals and delete others in the same pass.
for (const n of arb.ast[0].typeMap.Literal) {
  if (replacements[n.value]) {
    arb.replaceNode(n, {
      type: 'Literal',
      value: replacements[n.value],
      raw: `'${replacements[n.value]}'`,
    });
    continue;
  }

  if (n.value === 'drop') {
    arb.deleteNode(n);
  }
}

console.log(`Queued changes: ${arb.getNumberOfChanges()}`);
console.log(`Applied changes: ${arb.applyChanges()}`);
console.log(arb.script);
