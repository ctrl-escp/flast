# API Reference

This guide focuses on flAST's current public API surface and the behaviors that tend to matter in real analysis or transformation code.

## Table Of Contents
- [Exports](#exports)
- [`generateFlatAST(inputCode, opts?)`](#generateflatastinputcode-opts)
- [`Arborist`](#arborist)
- [`applyIteratively(script, funcs, maxIterations?)`](#applyiterativelyscript-funcs-maxiterations)
- [`logger`](#logger)
- [`generateCode(rootNode, opts?)`](#generatecoderootnode-opts)
- [`generateRootNode(inputCode, opts?)`](#generaterootnodeinputcode-opts)
- [`parseCode(inputCode, opts?)`](#parsecodeinputcode-opts)
- [Node Metadata Cheat Sheet](#node-metadata-cheat-sheet)
- [Behavior Notes That Matter In Practice](#behavior-notes-that-matter-in-practice)

## Exports
```js
import {
  Arborist,
  applyIteratively,
  generateFlatAST,
  logger,
  generateCode,
  generateRootNode,
  parseCode,
} from 'flast';
```

## `generateFlatAST(inputCode, opts?)`
The main flAST entry point. Returns an ordered flat array of enriched nodes.

### Returns
- `ASTNode[]`
- `[]` for invalid input
- Each node's `nodeId` equals its array index, so `ast[node.nodeId] === node`.

### Commonly Used Node Properties
- `nodeId`
- `src`
- `parentNode`
- `parentKey`
- `childNodes`
- `declNode`
- `references`
- `scope`
- `scopeId`
- `lineage`
- `ancestry`

### Root-Only Properties
- `typeMap`
- `allScopes`

### Options
#### `detailed?: boolean`
- Default: `true`
- When `false`, scope and identifier-relation enrichment is skipped.

#### `includeSrc?: boolean`
- Default: `true`
- When `false`, nodes do not store original source slices in `src`

#### `retainTokens?: boolean`
- Default: `true`
- When `false`, parser tokens are released after comments are attached
- Reduces retained AST memory while preserving attached comments; use the default if callers read `ast[0].tokens`
- Planned breaking-version default: `false`; callers that need `ast[0].tokens` should set `retainTokens: true` explicitly

#### `compactScopes?: boolean`
- Default: `false`
- When `true`, replaces the internal `eslint-scope` graph with the documented scope, variable, and reference fields after identifier linking
- Preserves `scopeId`, `type`, `block`, `upper`, `childScopes`, `variableScope`, variable identifiers, and resolved-reference links
- Omits undocumented `eslint-scope` internals such as `set` and `through`; leave this disabled if an integration reads those fields

#### `alternateSourceTypeOnFailure?: boolean`
- Default: `true`
- Retries parse with `sourceType: 'script'` after a compatible module parse failure

#### `parseOpts?: ParseCodeOptions`
- Forwarded to Espree

### Example
```js
const ast = generateFlatAST(code, {
  detailed: true,
  compactScopes: true,
  includeSrc: true,
  retainTokens: false,
  alternateSourceTypeOnFailure: true,
});
``` 

## `Arborist`
Safe mutation helper for replacing and deleting nodes, then validating the resulting script.

### Construction
```js
const arbFromCode = new Arborist(script);
const memoryEfficientArb = new Arborist(script, {
  compactScopes: true,
  retainTokens: false,
});
const arbFromAst = new Arborist(generateFlatAST(script));
```

Options passed with source code are reused for every validated rebuild.

### Replacement modes

- A **full rebuild** generates source, reparses it, and recreates detailed scope and identifier metadata.
- A **metadata-reuse rebuild** generates source and reparses the basic AST, but restores verified compact scope metadata instead of running scope analysis again.

Arborist always regenerates source and reparses an AST after successful mutations. The optimization changes how much metadata must be recomputed; it does not skip rebuilding the structural AST.

With `compactScopes: true`, a replacement batch is eligible for a metadata-reuse rebuild only when all of these conditions hold:

1. Detailed metadata is enabled and the current AST contains compact scopes.
2. The batch contains at least one replacement and no deletions.
3. Every replacement is one of these explicitly supported forms:
   - A `Literal` that remains in the same category: string, number, boolean, null, BigInt, or regular expression.
   - A `BinaryExpression` operator change with the exact same `left` and `right` node objects.
   - A `LogicalExpression` operator change with the exact same `left` and `right` node objects.
   - An `AssignmentExpression` operator change with the exact same `left` and `right` node objects.
   - A `UnaryExpression` operator change with the exact same `argument` node object.
   - An `UpdateExpression` operator or prefix change with the exact same `argument` node object.
4. No target is part of a directive prologue, because changing directives can alter strict-mode scope semantics.
5. Replacement nodes do not introduce new leading or trailing comments.
6. The metadata snapshot contains scope, ancestry, and lineage information for every node.
7. After reparsing, node count, node type, `parentKey`, and parent `nodeId` match at every AST-array index.

Operand identity is required so an operator replacement cannot introduce changed identifiers or bindings under an otherwise approved expression type. Failure of any condition uses the full rebuild. Identifiers, bindings, other structural changes, directives, comments, deletions, and unknown nodes therefore never use metadata reuse.

The replacement operator must also belong to the target node's ESTree operator family. For example, `&&` is not accepted for a queued `BinaryExpression`, because reparsing that source produces a `LogicalExpression`. Negative numbers, negative BigInts, `NaN`, and negative zero are likewise excluded because they cannot reparse as one `Literal` node.

Compound assignment operators are not eligible when the left operand is an `ArrayPattern` or `ObjectPattern`; JavaScript only permits plain `=` assignment for destructuring targets. If a basic rebuild cannot parse generated source, Arborist skips the equivalent detailed parse and immediately restores the original AST.

When metadata reuse is selected, `retainTokens: false` is configured, and no parser or attached comments exist anywhere in the current AST, Arborist also uses a lean basic parse without token/comment arrays. Comment-bearing ASTs and token-retaining configurations always use the rich parse path.

### Literal `value` and `raw`

For ordinary string, boolean, null, decimal, hexadecimal, and similar literals, escodegen checks whether `raw` represents `value`; a stale `raw` value is normally ignored. For example, `{value: 2, raw: '1'}` generates `2`.

Do not rely on that behavior for every literal form. BigInt generation uses `bigint`/`raw`, regular-expression generation uses `regex`, and numeric-separator literals can preserve an underscore-containing `raw` string. When changing those literals, update all corresponding fields or remove stale formatting fields where supported.

### Hash behavior

Every successful Arborist replacement updates `arb.script`, regardless of rebuild mode. `applyIteratively()` hashes that generated script after every successful `applyChanges()` call, so metadata reuse does not bypass hash updates. The hash remains unchanged only when the generated source string itself remains unchanged—for example, when stale literal metadata causes the old spelling to be emitted.

### Important Properties
- `script`: current generated script
- `ast`: current flat AST
- `markedForDeletion`
- `replacements`
- `appliedCounter`
- `logger`

### Important Methods
#### `markNode(targetNode, replacementNode?)`
- Low-level queueing primitive used by the convenience helpers below
- Marks a node for replacement when `replacementNode` is provided
- Marks a node for deletion when omitted
- Ignores a target when that node or one of its ancestors is already marked
- Allows any number of sibling targets, including adjacent children of the same array
- Distinguishes replacement marks from deletion marks when deciding whether a removable parent can be deleted

#### `replaceNode(targetNode, replacementNode)`
- Queues a replacement without relying on an optional second argument
- Preferred in examples and user-facing code when you are replacing a node

#### `deleteNode(targetNode)`
- Queues a deletion without relying on an omitted argument
- Preferred in examples and user-facing code when you are deleting a node

#### `getNumberOfChanges()`
- Returns the number of queued mutations

#### `applyChanges()`
- Applies queued replacements/deletions
- Groups large sibling batches and ordered adjacent replacement/deletion runs by their parent array
- Regenerates code
- Reparses the result
- Reverts if the generated code is invalid
- Returns number of applied changes

### Gotchas
- Deleting a node may target a higher removable parent for validity
- Deleting or replacing the root behaves differently from leaf edits
- Comments are merged and preserved where possible, but complex transforms should still be tested

## `applyIteratively(script, funcs, maxIterations?)`
Runs one or more Arborist-based transforms repeatedly until no changes are made or the iteration limit is reached.

### Typical Use
```js
function transform(arb) {
  for (const node of arb.ast[0].typeMap.Literal) {
    if (node.value === 'a') {
      arb.replaceNode(node, {type: 'Literal', value: 'b', raw: "'b'"});
    }
  }
  return arb;
}

const result = applyIteratively(script, [transform], 3);
```

### Notes
- Useful when one transform unlocks another in a later pass
- Resilient against invalid end states because Arborist validates changes
- Later transforms can still run even if an earlier one throws

## `logger`
Simple shared logger used by flAST utilities.

### Useful Methods
- `setLogLevelDebug()`
- `setLogLevelLog()`
- `setLogLevelError()`
- `setLogLevelNone()`
- `setLogFunc(fn)`

### Example
```js
import {logger} from 'flast';

logger.setLogLevelDebug();
logger.setLogFunc((...args) => {
  console.error('[flast]', ...args);
});
```

## `generateCode(rootNode, opts?)`
Generates JavaScript source from an AST node.

### Returns
- generated code string

### Notes
- Uses escodegen under the hood
- Supports escodegen-style generation options
- Preserves comments when present and supported by the node structure

## `generateRootNode(inputCode, opts?)`
Parses input and returns a root node or `null`.

### Returns
- `Program` node on success
- `null` on invalid input

### Important Behavior
- When `alternateSourceTypeOnFailure` is enabled, flAST can retry parsing with `sourceType: 'script'`.
- When `includeSrc` is enabled, the root gets `src`.

## `parseCode(inputCode, opts?)`
Parses JavaScript with Espree and returns the parser root node.

### Returns
- `Program` AST root

### Notes
- flAST enables comment and range support.
- Comments are attached when tokens are available.
- Use this when you want parser output directly rather than flAST's flat representation.

## Node Metadata Cheat Sheet
### Navigation
- `parentNode`
- `childNodes`
- `parentKey`

### Source
- `src`
- `start`
- `end`
- `range`
- `loc`

### Identity
- `nodeId`
- `type`

### Scope And Symbol Info
- `scope`
- `scopeId`
- `lineage`
- `ancestry`
- `declNode`
- `references`

## Behavior Notes That Matter In Practice
- `generateFlatAST('return a;', {alternateSourceTypeOnFailure: false})` returns `[]`.
- `generateRootNode('return a;', {alternateSourceTypeOnFailure: false})` returns `null`.
- `typeMap` returns `[]` for missing node types.
- Module-scope parse failures may be retried in script mode.
- `detailed: false` trades metadata for speed and lower memory use.
