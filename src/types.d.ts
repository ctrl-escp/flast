import type {Options as EspreeOptions} from 'espree';

export type ParseCodeOptions = EspreeOptions;

export interface GenerateFlatASTOptions {
  detailed?: boolean;
  includeSrc?: boolean;
  alternateSourceTypeOnFailure?: boolean;
  parseOpts?: ParseCodeOptions;
}

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

export interface ASTScope {
  block: ASTNode;
  childScopes: ASTScope[];
  scopeId: number;
  type: string;
  upper?: ASTScope | null;
  variables?: Array<{
    name: string;
    identifiers: ASTNode[];
  }>;
  references?: Array<{
    identifier: ASTNode;
    resolved?: {
      identifiers?: ASTNode[];
    } | null;
  }>;
  variableScope?: ASTScope;
  [key: string]: unknown;
}

export interface ASTTypeMap {
  typeList: string[];
  [key: string]: ASTNode[] | string[];
}
export type ASTAllScopes = Record<number, ASTScope>;
export type ScopeVariableMap = Record<string, unknown>;
export type ScopeVariableMapByScopeId = Record<number, ScopeVariableMap>;

export interface ASTPosition {
  column: number;
  line: number;
}

export interface ASTSourceLocation {
  end: ASTPosition;
  source?: string | null;
  start: ASTPosition;
}

export interface ASTNode {
  type: string;
  alternate?: ASTNode | null;
  allScopes?: ASTAllScopes;
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
  childNodes?: ASTNode[];
  comments?: object[];
  computed?: boolean;
  consequent?: ASTNode | null;
  cooked?: string;
  declaration?: ASTNode | null;
  declarations?: ASTNode[];
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
  key?: ASTNode | null;
  kind?: string;
  label?: ASTNode | null;
  leadingComments?: object[];
  lineage?: number[];
  left?: ASTNode | null;
  local?: ASTNode | null;
  loc?: ASTSourceLocation | null;
  meta?: ASTNode | null;
  method?: boolean;
  name?: string;
  nodeId?: number;
  object?: ASTNode | null;
  operator?: string;
  optional?: boolean;
  options?: ASTNode | null;
  parentKey?: string;
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
  references?: ASTNode[];
  regex?: ASTNode;
  right?: ASTNode | null;
  scope?: ASTScope;
  scopeId?: number;
  scriptHash?: string;
  shorthand?: boolean;
  source?: ASTNode | null;
  sourceType?: string;
  specifiers?: ASTNode[];
  src?: string;
  start?: number;
  static?: boolean;
  superClass?: ASTNode | null;
  tag?: ASTNode | null;
  tail?: boolean;
  test?: ASTNode | null;
  tokens?: object[];
  trailingComments?: object[];
  typeMap?: ASTTypeMap;
  update?: ASTNode | null;
  value?: ASTNode | string | number | boolean | bigint | RegExp | null;
  [key: string]: unknown;
}

export interface ASTRootNode extends ASTNode {
  body: ASTNode[];
  end: number;
  sourceType: 'script' | 'module';
  start: number;
}

export class Arborist {
  script: string;
  ast: ASTNode[];
  markedForDeletion: number[];
  appliedCounter: number;
  replacements: Array<[ASTNode, ASTNode | object]>;
  logger: typeof logger;

  constructor(scriptOrFlatAstArr: string | ASTNode[]);
  _getCorrectTargetForDeletion(startNode: ASTNode): ASTNode;
  getNumberOfChanges(): number;
  markNode(targetNode: ASTNode, replacementNode?: ASTNode | object): void;
  replaceNode(targetNode: ASTNode, replacementNode: ASTNode | object): void;
  deleteNode(targetNode: ASTNode): void;
  static mergeComments(target: ASTNode | object, source: ASTNode, which: 'leadingComments' | 'trailingComments'): void;
  applyChanges(): number;
}

export function parseCode(inputCode: string, opts?: ParseCodeOptions): ASTRootNode;
export function generateFlatAST(inputCode: string, opts?: GenerateFlatASTOptions): ASTNode[];
export function generateCode(rootNode: ASTNode, opts?: GenerateCodeOptions): string;
export function generateRootNode(inputCode: string, opts?: GenerateFlatASTOptions): ASTRootNode | null;
export function extractNodesFromRoot(rootNode: ASTRootNode, opts?: GenerateFlatASTOptions): ASTNode[];
export function mapIdentifierRelations(node: ASTNode, scopeVarMaps: ScopeVariableMapByScopeId): void;

export function applyIteratively(script: string, funcs: Array<(arb: Arborist) => Arborist>, maxIterations?: number): string;

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
