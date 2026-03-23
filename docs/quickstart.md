# Quickstart

This guide gets you from `npm install flast` to useful analysis and transformation scripts quickly.

## Table Of Contents
- [Install](#install)
- [Quickstart Transform Boilerplate](#quickstart-transform-boilerplate)
- [ESM Starter](#esm-starter)
- [Parse, Inspect, Generate](#parse-inspect-generate)
- [Mental Model](#mental-model)
- [Fastest Useful Patterns](#fastest-useful-patterns)
- [Useful Next Steps](#useful-next-steps)

## Install
```bash
npm install flast
```

## Quickstart Transform Boilerplate
`examples/quickstart.mjs`

```js
import fs from 'node:fs';
import {applyIteratively} from 'flast';

const filename = process.argv[2];

if (!filename) {
  console.error('Usage: node examples/quickstart.mjs <filename>');
  process.exit(1);
}

const code = fs.readFileSync(filename, 'utf8');
let script = code;

function matchAndTransform(arb) {
  for (const n of arb.ast) {
    if (/* describe a code structure */) {
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

script = applyIteratively(script, [matchAndTransform]);

if (script !== code) {
  console.log('Successfully transformed the script:');
  console.log(script);
} else {
  console.log('Nothing changed ¯\\_(ツ)_/¯');
}
```

Run:

```bash
node examples/quickstart.mjs path/to/input.js
```

## ESM Starter
`examples/find-identifiers.mjs`

```js
import fs from 'node:fs';
import {generateFlatAST} from 'flast';

const inputPath = process.argv[2];
const code = inputPath
  ? fs.readFileSync(inputPath, 'utf8')
  : `
const alias = console.log;
alias("hello");
`;

const ast = generateFlatAST(code);

console.log(`Parsed ${ast.length} nodes`);
console.log(`Identifiers: ${ast[0].typeMap.Identifier.map((n) => n.name).join(', ')}`);

for (const n of ast[0].typeMap.Identifier) {
  console.log({
    name: n.name,
    parentType: n.parentNode?.type,
    scopeType: n.scope?.type,
    declarationType: n.declNode?.parentNode?.type ?? null,
  });
}
```

Run:

```bash
node examples/find-identifiers.mjs path/to/input.js
```

## Parse, Inspect, Generate
```js
import {generateCode, generateFlatAST} from 'flast';

const code = 'const value = 1 + 2;';
const ast = generateFlatAST(code);

console.log(ast[0].typeMap.VariableDeclarator[0].id.name); // value
console.log(ast[0].typeMap.BinaryExpression[0].src); // 1 + 2
console.log(generateCode(ast[0])); // const value = 1 + 2;
```

## Mental Model
- `generateFlatAST(code)` gives you flAST's enriched flat array.
- `Arborist` is the safe edit layer. Reach for `replaceNode()`, `deleteNode()`, `applyChanges()`, `script`, and `ast`.
- `applyIteratively` is for repeated passes until no more changes are applied.
- `logger` is there when you want downstream logging integration.

## Fastest Useful Patterns
### Look Up Nodes By Type
```js
const calls = ast[0].typeMap.CallExpression;
const identifiers = ast[0].typeMap.Identifier;
const binaryExpressions = ast[0].typeMap.BinaryExpression;
```

### Find The Declaration Behind A Reference
```js
for (const node of ast[0].typeMap.Identifier) {
  if (node.declNode) {
    console.log(`${node.name} -> declaration node #${node.declNode.nodeId}`);
  }
}
```

### Count References To A Binding
```js
for (const node of ast[0].typeMap.Identifier) {
  if (node.references?.length) {
    console.log(`${node.name}: ${node.references.length} references`);
  }
}
```

## Useful Next Steps
- API reference: [api.md](api.md)
- Recipes: [recipes.md](recipes.md)
- Structure detection guide: [structure-detection.md](structure-detection.md)
- Runnable repo examples: [../examples/quickstart.mjs](../examples/quickstart.mjs), [../examples/code-statistics.mjs](../examples/code-statistics.mjs), [../examples/find-identifiers.mjs](../examples/find-identifiers.mjs)
