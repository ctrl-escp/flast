# flAST
[![Run Tests](https://github.com/ctrl-escp/flast/actions/workflows/node.js.yml/badge.svg?branch=main)](https://github.com/ctrl-escp/flast/actions/workflows/node.js.yml)
[![Downloads](https://img.shields.io/npm/dm/flast.svg?maxAge=43200)](https://www.npmjs.com/package/flast)

Efficient, flat, richly annotated JavaScript AST tooling for analysis, refactoring, deobfuscation, and code generation.

flAST turns JavaScript into a single flat array of nodes, then enriches those nodes with parent/child links, scope data, identifier relationships, original source snippets, and fast lookup indexes. That makes it especially useful when you want to detect structures in real-world code without writing a recursive tree walker every time.

## Table Of Contents
- [Why flAST](#why-flast)
- [Install](#install)
- [Getting Started](#getting-started)
- [What You Get Back](#what-you-get-back)
- [Core Concepts](#core-concepts)
- [Quick Examples](#quick-examples)
- [Which API Should I Use?](#which-api-should-i-use)
- [Best Practices](#best-practices)
- [Structure Detection Use Cases](#structure-detection-use-cases)
- [Copy-Paste Starters](#copy-paste-starters)
- [Troubleshooting And Gotchas](#troubleshooting-and-gotchas)
- [Contributing](#contributing)
- [License](#license)

## Why flAST
- Parse JavaScript into a flat AST that is easy to search and filter.
- Browse nodes by their type, like `ast[0].typeMap.Identifier`, `BinaryExpression`, `CallExpression`, and more.
- Follow identifier declarations and references via `declNode` and `references`.
- Track lexical context with `scope`, `scopeId`, `ancestry`, and `lineage`.
- Safely replace or delete nodes with `Arborist`.
- Run multi-pass transforms with `applyIteratively`.

## Install
Requires Node 18 or newer.

```bash
npm install flast
```

## Getting Started
### Extract Code Statistics
```js
import {generateFlatAST} from 'flast';

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
```

### Identify A Code Structure
```js
import {generateFlatAST} from 'flast';

// This script includes a few patterns that are common in deobfuscation work.
const code = `
const canBeResolved = 1 + 2;
const mixed = value + 3;
const nested = 4 * (5 + 6);
`;

const ast = generateFlatAST(code);

// These can be deterministically resolved because both sides are literals.
const deterministicallyResolvableBinaryExpressions = ast[0].typeMap.BinaryExpression
  .filter((n) => n.left?.type === 'Literal' && n.right?.type === 'Literal');

console.log(deterministicallyResolvableBinaryExpressions.map((n) => ({
  src: n.src,
  operator: n.operator,
})));
```

### Transform The Tree With `Arborist`
```js
import {Arborist} from 'flast';

// Start from the same kind of binary expressions that can be deterministically resolved.
const source = `
const a = 1 + 2;
const b = 10 - 3;
const c = 2 * 4;
const d = 8 / 2;
const e = 9 % 4;
`;

const arb = new Arborist(source);

function resolveBinaryExpression(n) {
  // Only resolve numeric literal operations that we handle explicitly.
  if (n.left?.type !== 'Literal' || n.right?.type !== 'Literal') return null;
  if (typeof n.left.value !== 'number' || typeof n.right.value !== 'number') return null;

  switch (n.operator) {
  case '+':
    return n.left.value + n.right.value;
  case '-':
    return n.left.value - n.right.value;
  case '*':
    return n.left.value * n.right.value;
  case '/':
    return n.right.value === 0 ? null : n.left.value / n.right.value;
  case '%':
    return n.right.value === 0 ? null : n.left.value % n.right.value;
  default:
    return null;
  }
}

// Queue deterministic replacements without executing arbitrary code.
for (const n of arb.ast[0].typeMap.BinaryExpression) {
  const value = resolveBinaryExpression(n);
  if (value !== null) {
    arb.replaceNode(n, {
      type: 'Literal',
      value,
      raw: String(value),
    });
  }
}

arb.applyChanges();
console.log(arb.script);
```

These cover three of the most common flAST workflows:
- Getting fast statistics from flat nodes and `typeMap.typeList`
- Identifying structures with focused node filters
- Transforming those structures safely with `Arborist`

## What You Get Back
`generateFlatAST(code)` returns an array where:
- `ast[0]` is the root `Program` node.
- Every node has a stable `nodeId`.
- Every node can expose `parentNode`, `childNodes`, `parentKey`, and `src`.
- `ast[0].typeMap` groups nodes by type for fast lookups and exposes `typeList` for the unique node types found in the script.
- Identifiers can expose `declNode` and `references`.
- Detailed nodes can expose `scope`, `scopeId`, `ancestry`, and `lineage`.
- `ast[0].allScopes` contains the discovered lexical scopes.

That means common workflows become straightforward:

```js
const ast = generateFlatAST(code);
const calls = ast[0].typeMap.CallExpression;
const literals = ast[0].typeMap.Literal;
const ids = ast[0].typeMap.Identifier;
const typeList = ast[0].typeMap.typeList;
```

## Core Concepts
### Flat AST
Instead of recursively traversing `body`, `expression`, `left`, `right`, and every other AST branch yourself, flAST gives you one ordered array of nodes. That is often much easier to filter, inspect, and batch-process.

### `typeMap`
The root node exposes `ast[0].typeMap`, a proxy-backed lookup object that returns an empty array for missing node types and provides `typeList` for the unique node types present in the script.

```js
// Use typeList for a quick summary, or access a specific bucket directly.
const binaryExpressions = ast[0].typeMap.BinaryExpression;
const classes = ast[0].typeMap.ClassDeclaration;
const typeList = ast[0].typeMap.typeList;
const hasFunctions = typeList.includes('FunctionDeclaration');
const missing = ast[0].typeMap.ThisTypeDoesNotExist; // []
```

### Identifier Relations
When `detailed` mode is enabled (which it is by default), identifiers are linked to their declaration and declarations track their references.

```js
// Each identifier knows where it was declared and how often it is referenced.
for (const n of ast[0].typeMap.Identifier) {
  console.log(n.name, {
    declaration: n.declNode?.name ?? n.declNode?.parentNode?.type,
    referenceCount: n.references?.length ?? 0,
  });
}
```

### Scope, Ancestry, And Lineage
Nodes can expose:
- `scope`: the resolved lexical scope for that node
- `scopeId`: the current scope id
- `ancestry`: the ordered chain of parent `nodeId`s from the root parent to the immediate parent
- `lineage`: the chain of scope ids leading to that node

These are especially useful for deobfuscation, structure detection, and safe rename/refactor workflows.

```js
// ancestry answers node-to-node nesting, while lineage answers scope nesting.
const fn = ast[0].typeMap.FunctionDeclaration[0];
const ids = ast[0].typeMap.Identifier;
const n = ids.find((id) => id.name === 'value');

console.log(n.ancestry); // e.g. [0, 1, 4]
console.log(n.ancestry.includes(fn.nodeId)); // true
```

## Quick Examples
### Parse And Generate
```js
import {generateCode, generateFlatAST} from 'flast';

// Parse code once, then regenerate it from the Program node.
const ast = generateFlatAST("console.log('hello')");
console.log(generateCode(ast[0])); // console.log('hello');
```

### Replace Nodes Safely With `Arborist`
```js
import {Arborist} from 'flast';

// Queue replacements and let Arborist validate the final script.
const arb = new Arborist("console.log('Hello' + ' ' + 'there!');");
const replacements = {
  Hello: 'General',
  'there!': 'Kenobi',
};

// Match the literals we want to rewrite.
for (const n of arb.ast[0].typeMap.Literal) {
  if (replacements[n.value]) {
    arb.replaceNode(n, {
      type: 'Literal',
      value: replacements[n.value],
      raw: `'${replacements[n.value]}'`,
    });
  }
}

arb.applyChanges();
console.log(arb.script); // console.log('General' + ' ' + 'Kenobi');
```

### Delete Nodes Safely With `Arborist`
```js
import {Arborist} from 'flast';

// Deletions use the same workflow as replacements.
const arb = new Arborist("const values = ['drop', 'keep', 'drop'];");

// Remove every literal that matches the unwanted value.
for (const n of arb.ast[0].typeMap.Literal) {
  if (n.value === 'drop') {
    arb.deleteNode(n);
  }
}

arb.applyChanges();
console.log(arb.script); // const values = ['keep'];
```

### Run A Multi-Pass Transform
```js
import {applyIteratively} from 'flast';

function foldSimpleMath(arb) {
  // Each pass folds one constant-addition layer.
  for (const n of arb.ast[0].typeMap.BinaryExpression) {
    if (
      n.left.type === 'Literal' &&
      n.right.type === 'Literal' &&
      typeof n.left.value === 'number' &&
      typeof n.right.value === 'number' &&
      n.operator === '+'
    ) {
      const value = n.left.value + n.right.value;
      arb.replaceNode(n, {type: 'Literal', value, raw: String(value)});
    }
  }

  return arb;
}

// Re-run the transform until the expression is fully reduced.
console.log(applyIteratively('const x = 1 + 2 + 3;', [foldSimpleMath]));
```

## Which API Should I Use?
- Use `parseCode` if you want the parser root as produced by Espree.
- Use `generateRootNode` if you want a root node and are okay with `null` for invalid input.
- Use `generateFlatAST` if you want the main flAST workflow: flattened nodes plus metadata.
- Use `generateCode` if you want code back from an AST node.
- Use `Arborist` if you want safe deletions/replacements with validation.
- Use `applyIteratively` if you want a transformation pipeline that can run multiple passes until changes stop.
- Use `logger` if you want to debug or redirect flAST logging.

## Best Practices
- Prefer `ast[0].typeMap.<Type>` over scanning the whole AST.
- Keep match logic separate from transform logic for anything beyond trivial scripts.
- Use `declNode` and `references` instead of matching identifiers by name alone.
- Use `Arborist` for structural edits.
- Re-parse or rely on `applyChanges()` / `applyIteratively()` whenever correctness matters.
- Treat `detailed: false` as a performance mode for cases where you do not need scope or identifier metadata.

## Structure Detection Use Cases
flAST works especially well for identifying repeated code structures such as:
- Proxy variables and proxy references
- Computed member access like `obj["log"]`
- Wrapper IIFEs
- Deterministic `if` statements and constant expressions
- Fixed assigned values
- Shuffled array patterns used in obfuscation pipelines

These patterns show up heavily in reverse-engineering and deobfuscation tooling such as:
- [obfuscation-detector](https://github.com/ctrl-escp/obfuscation-detector)
- [REstringer](https://github.com/ctrl-escp/restringer)
- [flASTer](https://github.com/ctrl-escp/flaster)

See the dedicated guide: [docs/structure-detection.md](docs/structure-detection.md)

## Copy-Paste Starters
- Quickstart walkthrough: [docs/quickstart.md](docs/quickstart.md)
- API guide: [docs/api.md](docs/api.md)
- Practical recipes: [docs/recipes.md](docs/recipes.md)
- Structure detection guide: [docs/structure-detection.md](docs/structure-detection.md)
- Runnable scripts: [examples/quickstart.mjs](examples/quickstart.mjs), [examples/code-statistics.mjs](examples/code-statistics.mjs), [examples/find-identifiers.mjs](examples/find-identifiers.mjs), [examples/transform-with-arborist.mjs](examples/transform-with-arborist.mjs), [examples/apply-iteratively.mjs](examples/apply-iteratively.mjs), [examples/detect-structures.mjs](examples/detect-structures.mjs)

## Troubleshooting And Gotchas
- Invalid code passed to `generateFlatAST()` returns `[]` instead of throwing.
- Invalid code passed to `generateRootNode()` returns `null`.
- By default, flAST will retry parsing as `sourceType: 'script'` if parsing as a module fails in a compatible way.
- `detailed: false` removes scope, ancestry, and identifier relationship metadata.
- `includeSrc: false` skips storing `src` on nodes.
- `Arborist.applyChanges()` validates by regenerating and reparsing code before committing the updated script.
- Replacing the root node behaves differently from replacing a non-root node; it swaps the entire output program.
- Comments are preserved where possible during replacements and deletions, but you should still test transforms that move or remove large sections of code.

## Contributing
Contributions are welcome. For development details, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License
MIT
