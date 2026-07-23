import type {Options as EspreeOptions} from 'espree';

/** Options forwarded directly to Espree by {@link parseCode}. */
export type ParseCodeOptions = EspreeOptions;

/**
 * Controls parsing, decoration, and retained metadata for {@link generateFlatAST}.
 *
 * @example
 * const ast = generateFlatAST(source, {
 *   detailed: false,
 *   includeSrc: false,
 *   retainTokens: false,
 * });
 */
export interface GenerateFlatASTOptions {
  /** Include scopes, ancestry, lineage, and declaration/reference links. @default true */
  detailed?: boolean;
  /** Store each node's generated source slice in `node.src`. @default true */
  includeSrc?: boolean;
  /** Retain the parser token array after comments are attached. @default true */
  retainTokens?: boolean;
  /** Replace eslint-scope internals with flAST's smaller documented graph. @default false */
  compactScopes?: boolean;
  /** Retry failed module input as a script, enabling valid sloppy-mode syntax. @default true */
  alternateSourceTypeOnFailure?: boolean;
  /** Espree options; these override flAST's parser defaults. */
  parseOpts?: ParseCodeOptions;
}

/** Escodegen options accepted by {@link generateCode}. */
export interface GenerateCodeOptions {
  format?: {
    indent?: {
      style?: string;
      adjustMultilineComment?: boolean;
    };
    quotes?: 'single' | 'double' | 'auto';
    escapeless?: boolean;
    compact?: boolean;
    [key: string]: unknown;
  };
  comment?: boolean;
  sourceMap?: string;
  sourceMapWithCode?: boolean;
  [key: string]: unknown;
}

/**
 * A scope normalized by flAST.
 *
 * With `compactScopes: true`, only the declared fields are guaranteed; raw
 * eslint-scope objects may expose additional implementation details.
 */
export interface ASTScope {
  /** AST node that introduces this scope. */
  block: ASTNode;
  /** Immediately nested scopes. */
  childScopes: ASTScope[];
  /** Numeric key used by `root.allScopes` and node lineage arrays. */
  scopeId: number;
  /** eslint-scope category such as `global`, `function`, or `block`. */
  type: string;
  /** Nearest enclosing scope, or null for the outermost scope. */
  upper?: ASTScope | null;
  /** Variables declared in this scope and their declaration identifiers. */
  variables?: Array<{
    name: string;
    identifiers: ASTNode[];
  }>;
  /** Identifier references and the variables they resolve to. */
  references?: Array<{
    identifier: ASTNode;
    resolved?: {
      identifiers?: ASTNode[];
    } | null;
  }>;
  /** Scope that owns `var` declarations for this scope. */
  variableScope?: ASTScope;
  [key: string]: unknown;
}

/**
 * Nodes grouped by ESTree type.
 *
 * Unknown type keys return an empty array at runtime.
 *
 * @example
 * root.typeMap.Identifier.forEach(identifier => console.log(identifier.name));
 * root.typeMap.NotARealType; // []
 */
export interface ASTTypeMap {
  /** Encountered node types in first-seen traversal order. */
  typeList: string[];
  [key: string]: ASTNode[] | string[];
}

/** Normalized scopes keyed by numeric scope ID. */
export type ASTAllScopes = Record<number, ASTScope>;
/** Variables keyed by identifier name within one scope. */
export type ScopeVariableMap = Record<string, unknown>;
/** Variable-name maps keyed by numeric scope ID. */
export type ScopeVariableMapByScopeId = Record<number, ScopeVariableMap>;

/** Zero-based ESTree source position. */
export interface ASTPosition {
  column: number;
  line: number;
}

/** ESTree source range expressed as start and end line/column positions. */
export interface ASTSourceLocation {
  end: ASTPosition;
  source?: string | null;
  start: ASTPosition;
}

/**
 * ESTree node decorated with flAST traversal and relationship metadata.
 *
 * The defining invariant is `flatAst[node.nodeId] === node`.
 */
export interface ASTNode {
  type: string;
  alternate?: ASTNode | null;
  /** Root-only map of normalized scopes keyed by scope ID. */
  allScopes?: ASTAllScopes;
  /** Ancestor node IDs, ordered from the root to the direct parent. */
  ancestry?: number[];
  argument?: ASTNode | null;
  arguments?: ASTNode[];
  async?: boolean;
  attributes?: ASTNode[];
  await?: boolean;
  bigint?: string;
  block?: ASTNode;
  body?: ASTNode | ASTNode[] | null | boolean;
  callee?: ASTNode | null;
  cases?: ASTNode[];
  /** Direct AST children in source/traversal order. */
  childNodes?: ASTNode[];
  comments?: object[];
  computed?: boolean;
  consequent?: ASTNode | null;
  cooked?: string;
  declaration?: ASTNode | null;
  declarations?: ASTNode[];
  /** Declaration identifier resolved for this reference identifier. */
  declNode?: ASTNode;
  delegate?: boolean;
  discriminant?: ASTNode | null;
  directive?: string;
  elements?: Array<ASTNode | null>;
  end?: number;
  exported?: ASTNode | null;
  expression?: ASTNode | boolean | null;
  expressions?: ASTNode[];
  finalizer?: ASTNode | null;
  flags?: string;
  generator?: boolean;
  handler?: ASTNode | null;
  id?: ASTNode | null;
  imported?: ASTNode | null;
  init?: ASTNode | null;
  innerComments?: object[];
  isEmpty?: boolean;
  isMarked?: boolean;
  isMarkedForDeletion?: boolean;
  key?: ASTNode | null;
  kind?: string;
  label?: ASTNode | null;
  leadingComments?: object[];
  /** Enclosing scope IDs, ordered from outermost to innermost. */
  lineage?: number[];
  left?: ASTNode | null;
  local?: ASTNode | null;
  loc?: ASTSourceLocation | null;
  meta?: ASTNode | null;
  method?: boolean;
  name?: string;
  /** Index of this node in the flat AST array. */
  nodeId?: number;
  object?: ASTNode | null;
  operator?: string;
  optional?: boolean;
  options?: ASTNode | null;
  parentKey?: string;
  /** Direct AST parent; absent only on the program root. */
  parentNode?: ASTNode | null;
  param?: ASTNode | null;
  params?: ASTNode[];
  pattern?: string;
  prefix?: boolean;
  property?: ASTNode | null;
  properties?: ASTNode[];
  quasi?: ASTNode | null;
  quasis?: ASTNode[];
  range?: number[];
  raw?: string;
  /** Reference identifiers resolved to this declaration identifier. */
  references?: ASTNode[];
  regex?: ASTNode;
  right?: ASTNode | null;
  /** Innermost normalized scope containing this node. */
  scope?: ASTScope;
  scopeId?: number;
  scriptHash?: string;
  shorthand?: boolean;
  source?: ASTNode | null;
  sourceType?: string;
  specifiers?: ASTNode[];
  /** Source slice corresponding to this node when `includeSrc` is enabled. */
  src?: string;
  start?: number;
  static?: boolean;
  superClass?: ASTNode | null;
  tag?: ASTNode | null;
  tail?: boolean;
  test?: ASTNode | null;
  tokens?: object[];
  trailingComments?: object[];
  /** Root-only index of nodes grouped by ESTree type. */
  typeMap?: ASTTypeMap;
  update?: ASTNode | null;
  value?: ASTNode | string | number | boolean | bigint | RegExp | null;
  [key: string]: unknown;
}

/** Program root returned by parsing helpers. */
export interface ASTRootNode extends ASTNode {
  body: ASTNode[];
  end: number;
  sourceType: 'script' | 'module';
  start: number;
}

/**
 * Queues AST replacements and deletions, then regenerates and validates source
 * once per batch.
 *
 * @example
 * const arborist = new Arborist('const answer = 41;');
 * const literal = arborist.ast[0].typeMap!.Literal[0];
 * arborist.replaceNode(literal, {type: 'Literal', value: 42});
 * arborist.applyChanges();
 * arborist.script; // 'const answer = 42;'
 */
export class Arborist {
  /** Latest generated source. */
  script: string;
  /** Current flat AST, indexed by each node's `nodeId`. */
  ast: ASTNode[];
  /** Node IDs queued for deletion. */
  markedForDeletion: number[];
  /** Number of successful apply operations. */
  appliedCounter: number;
  /** Existing/replacement node pairs queued for the next apply. */
  replacements: Array<[ASTNode, ASTNode | object]>;
  /** Flat-AST options reused whenever the source is rebuilt. */
  options: GenerateFlatASTOptions;
  /** Shared logger instance. */
  logger: typeof logger;

  /** Construct from source or an existing flat AST. */
  constructor(scriptOrFlatAstArr: string | ASTNode[], options?: GenerateFlatASTOptions);
  /** Promote a deletion to the nearest parent that can be removed safely. @internal */
  _getCorrectTargetForDeletion(startNode: ASTNode): ASTNode;
  /** Return the number of queued replacements and deletions. */
  getNumberOfChanges(): number;
  /** Queue a replacement when provided, otherwise queue a deletion. */
  markNode(targetNode: ASTNode, replacementNode?: ASTNode | object): void;
  /** Queue a node replacement for the next {@link applyChanges} call. */
  replaceNode(targetNode: ASTNode, replacementNode: ASTNode | object): void;
  /** Queue a node deletion for the next {@link applyChanges} call. */
  deleteNode(targetNode: ASTNode): void;
  /** Merge one leading or trailing comment collection without duplicating its array. */
  static mergeComments(target: ASTNode | object, source: ASTNode, which: 'leadingComments' | 'trailingComments'): void;
  /** Apply queued changes, rebuild the AST, and return the successful change count. */
  applyChanges(): number;
}

/**
 * Parse source directly with Espree-compatible options.
 *
 * Parse errors are thrown; use {@link generateRootNode} for null-on-failure
 * parsing and module-to-script fallback.
 */
export function parseCode(inputCode: string, opts?: ParseCodeOptions): ASTRootNode;

/**
 * Parse source into a preorder array where each node ID equals its array index.
 *
 * @example
 * const ast = generateFlatAST('const value = 1;');
 * ast[ast[2].nodeId!] === ast[2]; // true
 */
export function generateFlatAST(inputCode: string, opts?: GenerateFlatASTOptions): ASTNode[];

/**
 * Generate JavaScript from an ESTree node using Escodegen.
 *
 * @example
 * generateCode(generateRootNode('let value=1;')!); // 'let value = 1;'
 */
export function generateCode(rootNode: ASTNode, opts?: GenerateCodeOptions): string;

/** Parse source with flAST defaults, returning null when all configured attempts fail. */
export function generateRootNode(inputCode: string, opts?: GenerateFlatASTOptions): ASTRootNode | null;

/** Flatten an already parsed ESTree program and attach flAST metadata. */
export function extractNodesFromRoot(rootNode: ASTRootNode, opts?: GenerateFlatASTOptions): ASTNode[];

/** Attach bidirectional declaration/reference links to one identifier node. */
export function mapIdentifierRelations(node: ASTNode, scopeVarMaps: ScopeVariableMapByScopeId): void;

/**
 * Run Arborist modifiers until a complete pass stops changing the source.
 *
 * @example
 * applyIteratively(source, [removeDeadCode, simplifyExpressions], 20);
 */
export function applyIteratively(script: string, funcs: Array<(arb: Arborist) => Arborist>, maxIterations?: number): string;

/**
 * Shared opt-in logger. Output is disabled until a level is selected.
 *
 * @example
 * logger.setLogLevelError();
 * logger.setLogFunc((...args) => collected.push(args));
 */
export const logger: {
  currentLogLevel: number;
  debug: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  logFunc: (...args: unknown[]) => void;
  logLevels: Record<string, number>;
  setLogLevel: (newLogLevel: number) => void;
  setLogLevelDebug: () => void;
  setLogLevelError: () => void;
  setLogLevelLog: () => void;
  setLogLevelNone: () => void;
  setLogFunc: (newLogFunc: (...args: unknown[]) => void) => void;
};
