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

#### `alternateSourceTypeOnFailure?: boolean`
- Default: `true`
- Retries parse with `sourceType: 'script'` after a compatible module parse failure

#### `parseOpts?: ParseCodeOptions`
- Forwarded to Espree

### Example
```js
const ast = generateFlatAST(code, {
  detailed: true,
  includeSrc: true,
  alternateSourceTypeOnFailure: true,
});
``` 

## `Arborist`
Safe mutation helper for replacing and deleting nodes, then validating the resulting script.

### Construction
```js
const arbFromCode = new Arborist(script);
const arbFromAst = new Arborist(generateFlatAST(script));
```

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
