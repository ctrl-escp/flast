# Structure Detection

flAST is particularly strong at identifying repeated code structures in minified, obfuscated, or machine-generated JavaScript. This guide focuses on patterns that show up in tools such as `obfuscation-detector`, `restringer`, and `flaster`.

The goal here is not to ship those higher-level tools inside flAST. The goal is to show how flAST makes those detection strategies practical.

## Table Of Contents
- [Detection Workflow](#detection-workflow)
- [Pattern Matcher Template](#pattern-matcher-template)
- [Proxy Variables](#proxy-variables)
- [Proxy References](#proxy-references)
- [Wrapper IIFEs](#wrapper-iifes)
- [Fixed Assigned Values](#fixed-assigned-values)
- [Deterministic Binary Expressions](#deterministic-binary-expressions)
- [Deterministic `if` Statements](#deterministic-if-statements)
- [Augmented Or Shuffled Arrays](#augmented-or-shuffled-arrays)
- [Practical Advice](#practical-advice)

## Detection Workflow
The most effective pattern is usually:

1. Narrow to candidate node types with `typeMap`
2. Apply a structural matcher
3. Use `declNode`, `references`, `scope`, and `src` to refine the match
4. Optionally transform matches with `Arborist`

## Pattern Matcher Template
```js
import {generateFlatAST} from 'flast';

export function findStructures(code) {
  const ast = generateFlatAST(code);
  const matches = [];
  const candidates = ast[0].typeMap.CallExpression;

  for (const n of candidates) {
    if (isInteresting(n)) matches.push(n);
  }

  return matches;
}

function isInteresting(n) {
  // A variable declared in the code (has a declNode) rather than a builtin or an implicit import
  return n.callee?.type === 'Identifier' && n.callee.declNode;
}
```

## Proxy Variables
Pattern:

```js
const originalVar = 'actual value';
const alias = originalVar;
console.log(alias);
```

Detection:

```js
function findProxyVariables(ast) {
  const matches = [];

  for (const n of ast[0].typeMap.VariableDeclarator) {
    if (
      n.id?.type === 'Identifier' &&
      n.init?.type === 'Identifier' &&
      n.init?.declNode?.parentNode?.type === 'VariableDeclarator' &&
      n.init.declNode.parentNode.init?.type === 'Literal'
    ) {
      matches.push(n);
    }
  }

  return matches;
}
```

## Proxy References
Pattern:

```js
const fn = console.log;
fn("hello");
```

Detection idea:
- Find proxy variable declarators
- Follow their `references`
- Inspect the parent usage of each reference

```js
function findProxyCallSites(ast) {
  const sites = [];

  for (const node of ast[0].typeMap.VariableDeclarator) {
    if (node.id?.type !== 'Identifier' || node.init?.type !== 'Identifier') continue;

    for (const ref of node.references || []) {
      if (ref.parentNode?.type === 'CallExpression' && ref.parentKey === 'callee') {
        sites.push({
          alias: node.id.name,
          target: node.init.name,
          call: ref.parentNode.src,
        });
      }
    }
  }

  return sites;
}
```

## Wrapper IIFEs
Pattern:

```js
(function () {
  setup();
})();
```

Detection:

```js
function findWrapperIifes(ast) {
  return ast[0].typeMap.CallExpression.filter((node) =>
    node.callee?.type === 'FunctionExpression' ||
    node.callee?.type === 'ArrowFunctionExpression',
  );
}
```

Useful refinements:
- Check whether the parent is an `ExpressionStatement`
- Inspect argument count
- Check whether the body only wraps another expression, call, or setup block

## Fixed Assigned Values
Pattern:

```js
let a = 5;
const b = "x";
var c = true;
```

Detection:

```js
function findFixedAssignedValues(ast) {
  return ast[0].typeMap.VariableDeclarator.filter((n) =>
    n.id?.type === 'Identifier' &&
    n.init?.type === 'Literal',
  );
}
```

## Deterministic Binary Expressions
Pattern:

```js
1 + 2
"a" + "b"
4 * 10
```

Detection:

```js
function findDeterministicBinaryExpressions(ast) {
  return ast[0].typeMap.BinaryExpression.filter((node) =>
    node.left?.type === 'Literal' &&
    node.right?.type === 'Literal',
  );
}
```

This is the analysis half of constant folding. It is also useful for spotting code that can be simplified in later passes.

## Deterministic `if` Statements
Pattern:

```js
if (true) {
  run();
}
```

Detection:

```js
function findDeterministicIfStatements(ast) {
  return ast[0].typeMap.IfStatement.filter((node) =>
    node.test?.type === 'Literal' ||
    (
      node.test?.type === 'UnaryExpression' &&
      node.test.argument?.type === 'Literal'
    ),
  );
}
```

## Augmented Or Shuffled Arrays
Pattern:

```js
const arr = ['a', 'b', 'c'];
(function (targetArray, shifts) {
  while (shifts--) {
    targetArray.push(targetArray.shift());
  }
})(arr, 1);
```

Detection strategy:
- Start from `CallExpression`
- Require an immediately invoked function expression or arrow function
- Require an identifier first argument whose declaration is initialized with an `ArrayExpression`
- Require a numeric literal second argument

```js
function findAugmentedArrayCandidates(ast) {
  return ast[0].typeMap.CallExpression.filter((node) => {
    const arrayArg = node.arguments?.[0];
    const arrayDecl = arrayArg?.declNode?.parentNode;

    return (
      (
        node.callee?.type === 'FunctionExpression' ||
        node.callee?.type === 'ArrowFunctionExpression'
      ) &&
      arrayArg?.type === 'Identifier' &&
      arrayDecl?.type === 'VariableDeclarator' &&
      arrayDecl.init?.type === 'ArrayExpression' &&
      node.arguments?.[1]?.type === 'Literal' &&
      !Number.isNaN(Number(node.arguments[1].value))
    );
  });
}
```

This pattern is borrowed from real deobfuscation workflows, but flAST itself is only supplying the AST and mutation tools. If you want to evaluate or rewrite these patterns, keep that logic in your own tool.

## Practical Advice
- Match as narrowly as you can with `typeMap` before inspecting node details to avoid iterating over all of the nodes.
- Use `declNode` and `references` to avoid mixing variables with the same name in different scopes.
- Try not to rely on `src` to identify nodes, but on explicit attributes and relationships.
