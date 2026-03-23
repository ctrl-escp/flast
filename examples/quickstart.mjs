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
