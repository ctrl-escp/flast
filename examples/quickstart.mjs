import fs from 'node:fs';
import {applyIteratively} from '../src/index.js';

// Read the input file from the first CLI argument.
const filename = process.argv[2];

if (!filename) {
  console.error('Usage: node examples/quickstart.mjs <filename>');
  process.exit(1);
}

// Load the original source, then keep a mutable script copy for later passes.
const code = fs.readFileSync(filename, 'utf8');
let script = code;

/**
 * Decide which nodes this starter transform should replace.
 *
 * Replace this predicate with the structure relevant to your project. This
 * concrete default makes the example runnable and replaces string literals
 * whose value is exactly "value to replace".
 *
 * @example
 * codeStructureMatch({type: 'Literal', value: 'value to replace'}); // true
 * codeStructureMatch({type: 'Identifier', name: 'value to replace'}); // false
 *
 * @param {import('../src/types.d.ts').ASTNode} node Candidate AST node.
 * @return {boolean} Whether the starter replacement should be queued.
 */
function codeStructureMatch(node) {
  return node.type === 'Literal' && node.value === 'value to replace';
}

/**
 * Queue replacements for every node accepted by codeStructureMatch().
 *
 * @example
 * // Input containing "value to replace" becomes "replacement value".
 * applyIteratively(source, [matchAndTransform]);
 *
 * @param {import('../src/types.d.ts').Arborist} arb Current mutation queue.
 * @return {import('../src/types.d.ts').Arborist} The same queue for applyIteratively.
 */
function matchAndTransform(arb) {
  // Scan the whole flat AST and queue replacements or deletions for matches.
  for (const n of arb.ast) {
    if (codeStructureMatch(n)) {
      const replacementNode = {
        type: 'Literal',
        value: 'replacement value',
        raw: "'replacement value'",
      };
      arb.replaceNode(n, replacementNode);
      // arb.deleteNode(n);
    }
  }

  return arb;
}

// Re-run the transform until no more matching nodes are found.
script = applyIteratively(script, [matchAndTransform]);

if (script !== code) {
  console.log('Successfully transformed the script:');
  console.log(script);
} else {
  console.log('Nothing changed ¯\\_(ツ)_/¯');
}
