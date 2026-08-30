# API Reference

This guide focuses on flAST's current public API surface and the behaviors that tend to matter in real analysis or transformation code.

## Table Of Contents
- [Exports](#exports)
- [`generateFlatAST(inputCode, opts?)`](#generateflatastinputcode-opts)
- [`Arborist`](#arborist)
- [`applyChangesSafely(arborist)`](#applychangessafelyarborist)
- [`applyIteratively(script, funcs, options?)`](#applyiterativelyscript-funcs-options)
- [`applyIterativelySafely(script, funcs, options?)`](#applyiterativelysafelyscript-funcs-options)
- [`applyIterativelyAsync(script, funcs, options?)`](#applyiterativelyasyncscript-funcs-options)
- [`applyIterativelyAsyncSafely(script, funcs, options?)`](#applyiterativelyasyncsafelyscript-funcs-options)
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
  applyChangesSafely,
  applyIteratively,
  applyIterativelySafely,
  applyIterativelyAsync,
  applyIterativelyAsyncSafely,
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
- Sources with no possible comment marker skip token and comment allocation entirely when this is `false`
- Detection includes line/block comments, hashbangs, and legacy HTML comments; ambiguous markers inside strings conservatively keep the rich parse path
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

#### `nextMajorDefaults?: boolean`
- Enables planned breaking defaults for one operation
- Currently makes `retainTokens` default to `false`
- Also makes `compactScopes` default to `true` for flat ASTs and Arborist instances
- Explicit `retainTokens` and `compactScopes` values still win
- An explicit `false` disables `FLAST_NEXT_MAJOR_DEFAULTS` for that call
- Applies to `generateFlatAST()`, `generateRootNode()`,
  `extractNodesFromRoot()`, `new Arborist()`, and `applyIteratively()`
- Does not alter `parseCode()`, which is a low-level Espree wrapper whose
  parser options are always explicit

`generateRootNode()` applies the token-retention default, but scope compaction
only becomes relevant when `extractNodesFromRoot()` builds the flat AST.
When `new Arborist(existingAst)` receives an already-built AST, the supplied
tree is preserved as-is; the previewed options apply to later rebuilds.

The same preview can be enabled process-wide in Node.js:

```sh
FLAST_NEXT_MAJOR_DEFAULTS=1 node transform.mjs
```

Browser builds can use only the programmatic flag and do not require a Node.js
`process` shim.

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
   - A `TemplateElement` that keeps the same `tail` role and changes `value.raw` to plain delimiter-free text.
   - A `YieldExpression` that keeps the exact same `argument` node and changes only `delegate`.
   - A `ForOfStatement` that keeps the exact same `left`, `right`, and `body` nodes and changes only `await`; enabling `await` additionally requires an enclosing async function.
   - A `BinaryExpression` operator change with the exact same `left` and `right` node objects.
   - A `LogicalExpression` operator change with the exact same `left` and `right` node objects.
   - An `AssignmentExpression` operator change with the exact same `left` and `right` node objects.
   - A `UnaryExpression` operator change with the exact same `argument` node object.
   - An `UpdateExpression` operator or prefix change with the exact same `argument` node object.
4. No target is part of a directive prologue, because changing directives can alter strict-mode scope semantics.
5. Replacement nodes do not introduce new leading or trailing comments.
6. Every node's scope resolves into the compact scope graph. Ancestry and lineage
   are reconstructed from the newly parsed parent and scope links instead of
   being retained in the snapshot.
7. After reparsing, node count, node type, `parentKey`, and parent `nodeId` match at every AST-array index.

Declaration `references` arrays are also reconstructed as the inverse of saved
`declNode` links. This avoids retaining duplicate forward and reverse reference
arrays while the old and new ASTs overlap in memory. Declaration links are
stored as packed reference/declaration ID pairs when sparse. Identifier-dense
programs retain the dense node-indexed representation when it requires fewer
integers than packed pairs.

Scope IDs are restored directly from compact scope records and their block node
IDs, avoiding another typed array sized to the complete AST.

Operand identity is required so an operator replacement cannot introduce changed identifiers or bindings under an otherwise approved expression type. Failure of any condition uses the full rebuild. Identifiers, bindings, other structural changes, directives, comments, deletions, and unknown nodes therefore never use metadata reuse.

The replacement operator must also belong to the target node's ESTree operator family. For example, `&&` is not accepted for a queued `BinaryExpression`, because reparsing that source produces a `LogicalExpression`. Negative numbers, negative BigInts, `NaN`, and negative zero are likewise excluded because they cannot reparse as one `Literal` node.

Compound assignment operators are not eligible when the left operand is an `ArrayPattern` or `ObjectPattern`; JavaScript only permits plain `=` assignment for destructuring targets. If a basic rebuild cannot parse generated source, Arborist skips the equivalent detailed parse and immediately restores the original AST.

For metadata reuse, replacement template text cannot contain a backslash, backtick, or `${`. Those characters can escape or introduce template delimiters and therefore require a full rebuild. This restriction affects optimization eligibility only; such replacements remain supported through the normal validated rebuild path.

When metadata reuse is selected, `retainTokens: false` is configured, and no parser or attached comments exist anywhere in the current AST, Arborist also uses a lean basic parse without token/comment arrays. Comment-bearing ASTs and token-retaining configurations always use the rich parse path.

### Literal `value` and `raw`

For ordinary string, boolean, null, decimal, hexadecimal, and similar literals, escodegen checks whether `raw` represents `value`; a stale `raw` value is normally ignored. For example, `{value: 2, raw: '1'}` generates `2`.

Do not rely on that behavior for every literal form. BigInt generation uses `bigint`/`raw`, regular-expression generation uses `regex`, and numeric-separator literals can preserve an underscore-containing `raw` string. When changing those literals, update all corresponding fields or remove stale formatting fields where supported.

### Iterative convergence

Every successful Arborist replacement updates `arb.script`, regardless of rebuild mode. `applyIteratively()` compares the generated source before and after each complete pass, so rejected edits and replacements that emit the same source converge immediately. Arborist object identity detects a modifier that returns a different mutation session; no root marker or Node.js crypto dependency is used.

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

#### `serialize()` / `Arborist.deserialize(snapshot)`
- `serialize()` stores `script`, `options`, replacement `[nodeId, replacement]` pairs, and deletion `nodeId`s
- The AST is omitted; the same script and options rebuild the same `nodeId`s
- `deserialize` constructs a new Arborist and re-marks those ids
- Isolation trials in `applyChangesSafely` use this path so a subset can be tested without rematching a rebuilt tree

#### `applyChanges()`
- Applies queued replacements/deletions
- Groups large sibling batches and ordered adjacent replacement/deletion runs by their parent array
- Regenerates code
- Reparses the result
- Reverts if the generated code is invalid
- Clears the queues even when it reverts, so callers that need the original marks must snapshot first
- Returns number of applied changes

#### `finalizeScopes()`
- Requires an empty mutation queue
- Rebuilds a compact-scope Arborist once with full `eslint-scope` metadata
- Returns the same Arborist instance
- Is a no-op that preserves AST identity when full scopes already exist
- Swaps the AST and options only after a successful rebuild
- Keeps later `applyChanges()` calls in full-scope mode

```js
const arb = new Arborist(source, {
  compactScopes: true,
  retainTokens: false,
});

// Perform any number of compact editing passes.
arb.applyChanges();

// Materialize raw eslint-scope fields only when a consumer needs them.
arb.finalizeScopes();
console.log(arb.ast[0].allScopes[0].set);
```

### Gotchas
- Deleting a node may target a higher removable parent for validity
- Deleting or replacing the root behaves differently from leaf edits
- Comments are merged and preserved where possible, but complex transforms should still be tested

## `applyChangesSafely(arborist)`
Production commit when a modifier may queue some invalid replacements or deletions and the valid ones should still be kept.

`applyChanges()` stays atomic: one bad edit reverts the whole batch. Use that when a mixed queue should fail together (for example `applyIteratively` convergence). Use `applyChangesSafely` when losing hundreds of good edits because of one bad one is the worse outcome.

```js
const arb = new Arborist('const a = 1, b = 2;');
const literals = arb.ast[0].typeMap.Literal;
arb.replaceNode(literals[0], {type: 'Literal', value: 10});
arb.replaceNode(literals[1], {type: 'EmptyStatement'});

const {arborist, applied, rejected} = applyChangesSafely(arb);
// arborist === arb
// arb.script === 'const a = 10, b = 2;'
// applied === 1
// rejected[0] describes the EmptyStatement replacement
```

### Return value
- `arborist`: the same instance that was passed in
- `applied`: count returned by the successful `applyChanges()` commit
- `rejected`: edits that could not be kept

Each rejected record has:

- `type`: `'replace'` or `'delete'`
- `nodeId`: index on the **pre-apply** tree
- `target`: that original `ASTNode` (`type`, `src`, `parentKey`, …)
- `replacement`: queued replacement, only for replaces
- `error`: generate/parse message, an interaction note, or a skip reason
- `modifier` / `iteration`: set only by the iterative safely wrappers

An empty queue is a no-op: `{applied: 0, rejected: []}`.

### Isolation algorithm
Trials always start from the original `serialize()` snapshot. After a rebuild, old node objects are stale; `nodeId` is stable for the same script and options, so the AST is omitted on purpose.

1. Snapshot the queue (and `script`) immediately. `applyChanges()` clears marks even when it reverts.
2. Fast path: call `applyChanges()` on the input instance. If that commit succeeds, return. Isolation is skipped.
3. If the whole batch fails, try the group, then split any failing group in half and isolate each half. One bad edit among a thousand is found in about ten trials (`O(k log n)` for `k` independent faults).
4. A single failing change is rejected with its generate/parse error.
5. The union of accepted halves is tried once. If that fails, the halves interact: keep members in original order only while the growing prefix still parses. The rest are rejected as interactions.
6. Re-queue only the accepted marks on the input Arborist (by current `nodeId`) and call `applyChanges()` once.

When the program root is marked, `applyChanges()` replaces the entire program and ignores sibling marks. Those siblings are reported as rejected so they are not mistaken for applied edits.

Trial deserializations use lean options (`detailed: false`, `includeSrc: false`, `retainTokens: false`) because those flags do not change flatten order. `parseOpts` and script `sourceType` are kept so sloppy syntax such as `with` still parses. The final apply uses the input instance's real options. Isolation trials stay on the main thread.

If the session was built from an AST array and `script` is empty, the helper fills `script` from `ast[0].src` or `generateCode` before serializing.

## `applyIteratively(script, funcs, options?)`
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

const result = applyIteratively(script, [transform], {
  maxIterations: 3,
  mode: 'batch',
  arboristOptions: {
    compactScopes: true,
    retainTokens: false,
  },
});
```

To preview all planned iterative defaults without spelling them individually:

```js
const result = applyIteratively(script, modifiers, {
  nextMajorDefaults: true,
});
// Equivalent defaults: mode: 'batch', compactScopes: true,
// retainTokens: false. Explicit mode/arboristOptions still override them.
```

The numeric third argument remains supported as shorthand for
`{maxIterations: number}`.

To continue the printed iteration count (and the remaining
`maxIterations` budget) across multiple calls, pass the last completed
count as `currentIteration`:

```js
script = applyIteratively(script, [stageA], {maxIterations: 20});
// last log was e.g. Iteration #7
script = applyIteratively(script, [stageB], {
  currentIteration: 7,
  maxIterations: 20,
});
// logs continue at #8; 13 passes remain before the shared cap
```

`currentIteration` is options-only. The numeric shorthand still starts at `0`.

Optional `fn.maxMarkedNodes` (or `{maxMarkedNodes}` on the options object)
stops that modifier on the mark that would exceed the cap. flAST keeps the
same Arborist so already-queued marks still apply; the next iteration can
mark remaining nodes. The function body does not check the count.
`fn.maxMarkedNodes` wins when both the function and options set a cap.
`maxRunTimeMs` is ignored here; use `applyIterativelyAsync`.

```js
foldMath.maxMarkedNodes = 50;
script = applyIteratively(script, [foldMath]);
```

The next major release is planned to drop the numeric third argument and
`currentIteration`. A module-level counter will keep a single sequence
across calls. `{resetIterationsCounter: true}` will reprint that call from
`0` without zeroing the module total, and
`applyIteratively.resetIterationsCounter()` will reset the module counter.

### Modes

- `mode: 'sequential'` is the current default. It rebuilds after each modifier, so a later modifier sees the earlier modifier's regenerated AST.
- `mode: 'batch'` runs every modifier against one working AST and rebuilds once at the end of the pass. Use it for independent modifiers that can queue their edits together.
- Batch mode throws if a modifier returns a different Arborist while the current one has pending edits. Use sequential mode for that pipeline so edits are never discarded.
- Ordinary modifier exceptions are logged when enabled and do not prevent later modifiers from running.

The next major release is also planned to make `batch` the default and to
construct the internal iterative Arborist with `compactScopes: true` and
`retainTokens: false` by default. Pass `mode` and `arboristOptions` explicitly
when behavior must remain stable across that release.

### Notes
- Useful when one transform unlocks another in a later pass
- Resilient against invalid end states because Arborist validates changes
- Later transforms can still run even if an earlier one throws
- `maxMarkedNodes` stops a modifier at the cap without discarding its queue
- Use `applyIterativelySafely` when a modifier may queue some invalid edits and the rest should still apply

## `applyIterativelySafely(script, funcs, options?)`
Same arguments, modes, and `maxMarkedNodes` behavior as `applyIteratively`. Each sequential (or batch) commit uses `applyChangesSafely` instead of atomic `applyChanges()`.

Returns `{script, rejected}` rather than a bare string so callers can review what a modifier got wrong. `rejected` is concatenated across every safe commit in the run.

- Sequential: isolate after each modifier that queued edits. Later modifiers see the kept tree. Each rejected record is stamped with `modifier` and a one-based `iteration` matching the iteration log.
- Batch: isolate the combined queue once per pass. Rejected records get `iteration` only; the queue is not attributed to one modifier.
- A fully rejected pass leaves source unchanged and stops, same as today's "no changes" signal.
- A replaced Arborist with no queued marks is unchanged.

```js
function mixed(arb) {
  const literals = arb.ast[0].typeMap.Literal;
  arb.replaceNode(literals[0], {type: 'Literal', value: 10});
  arb.replaceNode(literals[1], {type: 'EmptyStatement'});
  return arb;
}

const {script, rejected} = applyIterativelySafely('const a = 1, b = 2;', [mixed]);
// script === 'const a = 10, b = 2;'
// rejected[0].modifier === 'mixed'
// rejected[0].iteration === 1
```

`applyIteratively()` itself is unchanged. Use it when a mixed queue should fail together.

## `applyIterativelyAsync(script, funcs, options?)`
Same loop as `applyIteratively`, returning a Promise. When `fn.maxRunTimeMs` is
set, that invocation runs in a Node `worker_threads` isolate. After the budget,
the worker is terminated; marks already received still apply.

### Worker reconstruction
Workers cannot receive function objects. The main thread sends
`Function.prototype.toString.call(modifier)` plus an `Arborist.serialize()`
snapshot. The isolate rebuilds the function with `(0, eval)(\`(${modifierSource})\`)`:

- `Function.prototype.toString` is the only structured-cloneable view of the modifier.
- `(0, eval)` is **indirect eval**. It runs in the worker global scope, not in the worker module's local scope (`parentPort`, `snapshot`, imported `Arborist`). Direct `eval(modifierSource)` would also inherit those locals.
- The extra parentheses force `toString` output of a declaration or expression to parse as an expression so `eval` returns the function.
- Closures, closed-over tables, and other captured bindings are not available in the worker. Put constants inside the function or read them from the AST. There is no public context bag.
- This evaluates caller-supplied source in a Node isolate. It is not a sandbox.

Marks are posted as they queue (`_onMark` → `{nodeId, replacement}`) so the main Arborist can mirror them before `terminate()`. Replacements must be structured-cloneable. In-flight mark messages may be dropped when the worker is terminated. Rebuild time is not part of the budget.

The mark cap is the same as the sync API (`fn.maxMarkedNodes` or
`{maxMarkedNodes}`). If both limits are set, whichever hits first stops the
invocation. Modifiers without `maxRunTimeMs` run in-process.

```js
function replaceLiterals(arb) {
  const replacements = {Hello: 'General'};
  for (const n of arb.ast[0].typeMap.Literal) {
    if (replacements[n.value]) {
      arb.replaceNode(n, {type: 'Literal', value: replacements[n.value]});
    }
  }
  return arb;
}
replaceLiterals.maxRunTimeMs = 1000;
replaceLiterals.maxMarkedNodes = 50;

const result = await applyIterativelyAsync(source, [replaceLiterals]);
```

## `applyIterativelyAsyncSafely(script, funcs, options?)`
Same loop as `applyIterativelyAsync`, committing with `applyChangesSafely`.

Worker timeouts still reconstruct the modifier with `Function.prototype.toString` and `(0, eval)`, still mirror `nodeId` marks, and still `terminate()` after `fn.maxRunTimeMs`. Isolation then runs on the **main thread** against those mirrored marks. Isolation trials are not dispatched to workers.

```js
mixed.maxRunTimeMs = 1000;
const {script, rejected} = await applyIterativelyAsyncSafely(source, [mixed]);
```

Returns `{script, rejected}` with the same sequential/batch stamps as `applyIterativelySafely`.

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
