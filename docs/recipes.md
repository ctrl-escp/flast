# Recipes

These recipes are practical patterns you can adapt in your own analyzers, refactorers, and deobfuscation pipelines.

## Table Of Contents
- [Analyze A File](#analyze-a-file)
- [Transform A File And Write The Result](#transform-a-file-and-write-the-result)
- [Recipe: Proxy Variable Detection](#recipe-proxy-variable-detection)
- [Recipe: Replace Proxy References](#recipe-replace-proxy-references)
- [Recipe: Find Computed Members](#recipe-find-computed-members)
- [Recipe: Fold Constant Addition](#recipe-fold-constant-addition)
- [Recipe: Match/Transform Separation](#recipe-matchtransform-separation)
- [Recipe: Identify Wrapper IIFEs](#recipe-identify-wrapper-iifes)
- [Recipe: Inspect Scopes](#recipe-inspect-scopes)
- [Recipe: Always Edit With `Arborist`](#recipe-always-edit-with-arborist)

## Analyze A File
```js
import fs from 'node:fs';
import {generateFlatAST} from 'flast';

const code = fs.readFileSync(process.argv[2], 'utf8');
const ast = generateFlatAST(code);

console.log({
  nodes: ast.length,
  identifiers: ast[0].typeMap.Identifier.length,
  calls: ast[0].typeMap.CallExpression.length,
  literals: ast[0].typeMap.Literal.length,
});
```

## Transform A File And Write The Result
```js
import fs from 'node:fs';
import {Arborist} from 'flast';

const inputPath = process.argv[2];
const outputPath = process.argv[3] ?? 'output.js';
const arb = new Arborist(fs.readFileSync(inputPath, 'utf8'));

for (const node of arb.ast[0].typeMap.Literal) {
  if (node.value === 'old-value') {
    arb.replaceNode(node, {
      type: 'Literal',
      value: 'new-value',
      raw: "'new-value'",
    });
  }
}

arb.applyChanges();
fs.writeFileSync(outputPath, arb.script, 'utf8');
```

## Recipe: Proxy Variable Detection
Find bindings such as `const alias = realName;`.

```js
import {generateFlatAST} from 'flast';

function findProxyVariables(code) {
  const ast = generateFlatAST(code);
  const matches = [];

  for (const n of ast[0].typeMap.VariableDeclarator) {
    if (
      n.id?.type === 'Identifier' &&
      n.init?.type === 'Identifier' &&
      n.id.name !== n.init.name
    ) {
      matches.push(n);
    }
  }

  return matches;
}
```

## Recipe: Replace Proxy References
```js
import {applyIteratively} from 'flast';

function replaceProxyReferences(arb) {
  for (const node of arb.ast[0].typeMap.VariableDeclarator) {
    if (node.id?.type === 'Identifier' && node.init?.type === 'Identifier') {
      for (const ref of node.references || []) {
        arb.replaceNode(ref, {
          type: 'Identifier',
          name: node.init.name,
        });
      }
    }
  }

  return arb;
}

const result = applyIteratively('var a = b; console.log(a);', [replaceProxyReferences]);
console.log(result);
```

## Recipe: Find Computed Members
Useful for patterns such as `console["log"]` or `obj[key]`.

```js
import {generateFlatAST} from 'flast';

function findComputedMembers(code) {
  const ast = generateFlatAST(code);
  return ast[0].typeMap.MemberExpression.filter((n) => n.computed);
}
```

## Recipe: Fold Constant Addition
```js
import {applyIteratively} from 'flast';

function foldConstantAddition(arb) {
  for (const node of arb.ast[0].typeMap.BinaryExpression) {
    if (
      node.operator === '+' &&
      node.left.type === 'Literal' &&
      node.right.type === 'Literal' &&
      typeof node.left.value === 'number' &&
      typeof node.right.value === 'number'
    ) {
      const value = node.left.value + node.right.value;
      arb.replaceNode(node, {type: 'Literal', value, raw: String(value)});
    }
  }

  return arb;
}
```

## Recipe: Match/Transform Separation
This pattern scales well once your transforms become more complex.

```js
function matchCandidates(arb) {
  return arb.ast[0].typeMap.CallExpression.filter((n) =>
    n.callee?.type === 'Identifier' && n.callee.name === 'debug',
  );
}

function transformMatches(arb, matches) {
  for (const n of matches) {
    arb.replaceNode(n.callee, {
      type: 'Identifier',
      name: 'console',
    });
  }

  return arb;
}

function runTransform(arb) {
  const matches = matchCandidates(arb);
  transformMatches(arb, matches);
  arb.applyChanges();
  return arb.script;
}
```

## Recipe: Identify Wrapper IIFEs
```js
import {generateFlatAST} from 'flast';

function findWrapperIifes(code) {
  const ast = generateFlatAST(code);
  return ast[0].typeMap.CallExpression.filter((node) =>
    node.callee?.type === 'FunctionExpression' ||
    node.callee?.type === 'ArrowFunctionExpression',
  );
}
```

## Recipe: Inspect Scopes
```js
import {generateFlatAST} from 'flast';

const ast = generateFlatAST(`
function outer() {
  const x = 1;
  function inner() {
    return x;
  }
}
`);

for (const node of ast[0].typeMap.Identifier) {
  console.log(node.name, {
    scopeType: node.scope?.type,
    scopeId: node.scope?.scopeId,
    lineage: node.lineage,
    ancestry: node.ancestry,
  });
}
```

## Recipe: Always Edit With `Arborist`
Use `Arborist` for code changes so replacements and deletions stay validated and comment-safe.

Reach for `Arborist` when:
- Deleting nodes
- Replacing nodes
- Editing array-backed statement lists
- Preserving validity and comments matters

Typical workflow:
- Create `const arb = new Arborist(script)`
- Queue edits with `replaceNode()` and `deleteNode()`
- Commit them with `applyChanges()`
- Read the updated source from `arb.script`
