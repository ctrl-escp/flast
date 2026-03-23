import fs from 'node:fs';
import {generateFlatAST} from '../src/index.js';

// Read a file path when provided, otherwise use a small inline demo.
const code = process.argv[2]
  ? fs.readFileSync(process.argv[2], 'utf8')
  : `
function outer(value) {
  const alias = value;
  function inner() {
    return alias;
  }
  return inner();
}
`;

const ast = generateFlatAST(code);

// Identifier nodes are linked to both their declarations and their references.
for (const n of ast[0].typeMap.Identifier) {
  console.log({
    name: n.name,
    nodeId: n.nodeId,
    parentType: n.parentNode?.type,
    scopeType: n.scope?.type,
    scopeId: n.scope?.scopeId,
    lineage: n.lineage,
    declarationNodeId: n.declNode?.nodeId ?? null,
    declarationType: n.declNode?.parentNode?.type ?? null,
    referenceCount: n.references?.length ?? 0,
    src: n.src,
  });
}
