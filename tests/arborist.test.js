import assert from 'node:assert';
import {describe, it} from 'node:test';
import {Arborist, generateFlatAST} from '../src/index.js';

/**
 * Reduce detailed node metadata to stable IDs for rebuild comparisons.
 * @param {import('../src/types.d.ts').ASTNode[]} ast Flat AST.
 * @return {object[]} Serializable node summaries.
 */
function summarizeDetailedNodes(ast) {
  return ast.map(node => ({
    type: node.type,
    nodeId: node.nodeId,
    parentId: node.parentNode?.nodeId,
    parentKey: node.parentKey,
    scopeId: node.scope?.scopeId,
    ancestry: node.ancestry,
    lineage: node.lineage,
    declarationId: node.declNode?.nodeId,
    referenceIds: node.references?.map(reference => reference.nodeId),
  }));
}

/**
 * Reduce compact scope relationships to stable IDs for rebuild comparisons.
 * @param {import('../src/types.d.ts').ASTNode[]} ast Flat AST.
 * @return {object[]} Serializable scope summaries.
 */
function summarizeDetailedScopes(ast) {
  return Object.values(ast[0].allScopes).map(scope => ({
    scopeId: scope.scopeId,
    type: scope.type,
    blockId: scope.block.nodeId,
    upperId: scope.upper?.scopeId,
    childIds: scope.childScopes.map(child => child.scopeId),
    variableScopeId: scope.variableScope?.scopeId,
    variables: scope.variables.map(variable => [
      variable.name,
      variable.identifiers.map(identifier => identifier.nodeId),
    ]),
    references: scope.references.map(reference => [
      reference.identifier.nodeId,
      reference.resolved?.identifiers?.map(identifier => identifier.nodeId),
    ]),
  }));
}

describe('Arborist tests', () => {
  it('Verify node replacement works as expected', () => {
    const code = 'console.log(\'Hello\' + \' \' + \'there!\');';
    const expectedOutput = 'console.log(\'General\' + \' \' + \'Kenobi\');';
    const replacements = {
      'Hello': 'General',
      'there!': 'Kenobi',
    };
    const arborist = new Arborist(code);
    arborist.ast.filter(n => n.type === 'Literal' && replacements[n.value])
      .forEach(n => arborist.markNode(n, {
        type: 'Literal',
        value: replacements[n.value],
        raw: `'${replacements[n.value]}'`,
      }));
    const numberOfChangesMade = arborist.applyChanges();
    const result = arborist.script;

    assert.equal(result, expectedOutput, 'Result does not match expected output.');
    assert.equal(numberOfChangesMade, Object.keys(replacements).length, 'The number of actual replacements does not match expectations.');
  });
  it('Verify the root node replacement works as expected', () => {
    const code = 'a;';
    const expectedOutput = 'b';
    const arborist = new Arborist(code);
    arborist.markNode(arborist.ast[0], {
      type: 'Identifier',
      name: 'b',
    });
    arborist.applyChanges();
    const result = arborist.script;

    assert.equal(result, expectedOutput, 'Result does not match expected output.');
  });
  it('Verify only the root node is replaced', () => {
    const code = 'a;b;';
    const expectedOutput = 'c';
    const arborist = new Arborist(code);
    arborist.markNode(arborist.ast[4], {
      type: 'Identifier',
      name: 'v',
    });
    arborist.markNode(arborist.ast[0], {
      type: 'Identifier',
      name: 'c',
    });
    arborist.applyChanges();
    const result = arborist.script;

    assert.equal(result, expectedOutput, 'Result does not match expected output.');
  });
  it('Verify node deletion works as expected', () => {
    const code = 'const a = [\'There\', \'can\', \'be\', \'only\', \'one\'];';
    const expectedOutput = 'const a = [\'one\'];';
    const literalToSave = 'one';
    const arborist = new Arborist(code);
    arborist.ast.filter(n => n.type === 'Literal' && n.value !== literalToSave).forEach(n => arborist.markNode(n));
    const numberOfChangesMade = arborist.applyChanges();
    const expectedNumberOfChanges = 4;
    const result = arborist.script;

    assert.equal(result, expectedOutput, 'Result does not match expected output.');
    assert.equal(numberOfChangesMade, expectedNumberOfChanges, 'The number of actual changes does not match expectations.');
  });
  it('Verify the correct node is targeted for deletion', () => {
    const code = 'var a = 1;';
    const expectedResult = '';
    const arborist = new Arborist(code);
    arborist.markNode(arborist.ast.find(n => n.type === 'VariableDeclarator'));
    arborist.applyChanges();
    assert.equal(arborist.script, expectedResult, 'An incorrect node was targeted for deletion.');
  });
  it('Verify deleting the root is ignored', () => {
    const arborist = new Arborist('a;');

    assert.doesNotThrow(() => arborist.deleteNode(arborist.ast[0]));
    assert.equal(arborist.getNumberOfChanges(), 0, 'A root deletion was queued');
    assert.equal(arborist.applyChanges(), 0);
    assert.equal(arborist.script, 'a;');
  });
  it('Verify a valid script can be used to initialize an arborist instance', () => {
    const code = 'console.log(\'test\');';
    let error = '';
    let arborist;
    const expectedArraySize = generateFlatAST(code).length;
    try {
      arborist = new Arborist(code);
    } catch (e) {
      error = e.message;
    }
    assert.ok(arborist?.script, `Arborist failed to instantiate. ${error ? `Error: ${  error}` : ''}`);
    assert.ok(!error, `Arborist instantiated with an error: ${error}`);
    assert.equal(arborist.script, code, 'Arborist script did not match initialization argument.');
    assert.equal(arborist.ast.length, expectedArraySize, 'Arborist did not generate a flat AST array.');
  });
  it('Verify a valid AST array can be used to initialize an arborist instance', () => {
    const code = 'console.log(\'test\');';
    const ast = generateFlatAST(code);
    let error = '';
    let arborist;
    try {
      arborist = new Arborist(ast);
    } catch (e) {
      error = e.message;
    }
    assert.ok(arborist?.ast?.length, `Arborist failed to instantiate. ${error ? `Error: ${  error}` : ''}`);
    assert.equal(error, '', `Arborist instantiated with an error: ${error}`);
    assert.deepEqual(arborist.ast, ast, 'Arborist ast array did not match initialization argument.');
  });
  it('Verify an empty AST can apply no changes', () => {
    const arborist = new Arborist([]);

    assert.equal(arborist.applyChanges(), 0);
    assert.deepEqual(arborist.ast, []);
  });
  it('Verify invalid changes are not applied', () => {
    const code = 'console.log(\'test\');';
    const arborist = new Arborist(code);
    arborist.markNode(arborist.ast.find(n => n.type === 'Literal'), {type: 'EmptyStatement'});
    arborist.markNode(arborist.ast.find(n => n.name === 'log'), {type: 'EmptyStatement'});
    arborist.applyChanges();
    assert.equal(arborist.script, code, 'Invalid changes were applied.');
  });
  it('Verify the AST is restored after invalid changes', () => {
    const code = 'console.log(\'test\');';
    const arborist = new Arborist(code);
    arborist.markNode(arborist.ast.find(n => n.type === 'Literal'), {type: 'EmptyStatement'});
    arborist.markNode(arborist.ast.find(n => n.name === 'log'), {type: 'EmptyStatement'});

    assert.equal(arborist.applyChanges(), 0, 'Invalid changes should not be reported as applied');
    assert.equal(arborist.script, code, 'The script changed after invalid changes');
    assert.equal(arborist.ast.find(n => n.type === 'MemberExpression').property.name, 'log',
      'The AST retained an invalid property replacement');
    assert.equal(arborist.ast.find(n => n.type === 'CallExpression').arguments[0].value, 'test',
      'The AST retained an invalid argument replacement');

    arborist.replaceNode(arborist.ast.find(n => n.type === 'Literal'), {type: 'Literal', value: 'ok'});
    assert.equal(arborist.applyChanges(), 1, 'The restored AST could not accept a later valid change');
    assert.equal(arborist.script, 'console.log(\'ok\');');
  });
  it('Restores the AST when a root replacement generates invalid source', () => {
    const code = 'const value = 1;';
    const arborist = new Arborist(code);
    arborist.replaceNode(arborist.ast[0], {type: 'Identifier', name: 'not valid'});

    assert.equal(arborist.applyChanges(), 0);
    assert.equal(arborist.script, code);
    assert.equal(arborist.ast[0].type, 'Program');
    assert.equal(arborist.ast.find(node => node.type === 'Identifier').name, 'value');
  });
  it('Verify comments aren\'t duplicated when replacing the root node', () => {
    const code = '//comment1\nconst a = 1, b = 2;';
    const expected = '//comment1\nconst a = 1;\nconst b = 2;';
    const arb = new Arborist(code);
    const decls = [];
    arb.ast.forEach(n => {
      if (n.type === 'VariableDeclarator') {
        decls.push({
          type: 'VariableDeclaration',
          kind: 'const',
          declarations: [n],
        });
      }
    });
    arb.markNode(arb.ast[0], {
      ...arb.ast[0],
      body: decls,
    });
    arb.applyChanges();
    assert.equal(arb.script, expected);
  });
  it('Verify repeated root replacements do not duplicate file header comments', () => {
    const expected = '//comment1\nvar a = 1;';
    let script = expected;

    for (let i = 0; i < 2; i++) {
      const arb = new Arborist(script);
      arb.markNode(arb.ast[0], {
        ...arb.ast[0],
      });
      arb.applyChanges();
      script = arb.script;
    }

    assert.equal(script, expected);
  });
  it('Verify comments are kept when replacing a node', () => {
    const code = `
// comment1
const a = 1;

// comment2
let b = 2;

// comment3
const c = 3;`;
    const expected = '// comment1\nvar a = 1;\n// comment2\nlet b = 2;\n// comment3\nvar c = 3;';
    const arb = new Arborist(code);
    arb.ast.forEach(n => {
      if (n.type === 'VariableDeclaration'
					&& n.kind === 'const') {
        arb.markNode(n, {
          ...n,
          kind: 'var',
        });
      }
    });
    arb.applyChanges();
    assert.equal(arb.script, expected);
  });
});

describe('Arborist edge case tests', () => {
  it('mergeComments appends onto existing comment arrays', () => {
    const target = {
      leadingComments: [{type: 'Line', value: 'existing'}],
    };
    const source = {
      leadingComments: [{type: 'Line', value: 'incoming'}],
    };

    Arborist.mergeComments(target, source, 'leadingComments');

    assert.deepEqual(target.leadingComments, [
      {type: 'Line', value: 'existing'},
      {type: 'Line', value: 'incoming'},
    ]);
  });

  it('Preserves comments when replacing a non-root node', () => {
    const code = 'const a = 1; // trailing\nconst b = 2;';
    const expected = 'const a = 1;\n// trailing\nconst b = 3;';
    const arb = new Arborist(code);
    const bDecl = arb.ast.find(n => n.type === 'VariableDeclarator' && n.id.name === 'b');
    arb.markNode(bDecl.init, {type: 'Literal', value: 3, raw: '3'});
    arb.applyChanges();
    assert.equal(arb.script, expected);
  });

  it('Preserves comments on replaced array siblings', () => {
    const code = '// keep-a\nconst a = 1;\n// keep-b\nconst b = 2;';
    const expected = '// keep-a\nvar a = 1;\n// keep-b\nvar b = 2;';
    const arb = new Arborist(code);
    for (const node of arb.ast.filter(n => n.type === 'VariableDeclaration')) {
      arb.markNode(node, {
        ...node,
        kind: 'var',
      });
    }

    arb.applyChanges();

    assert.equal(arb.script, expected);
  });

  it('Deleting the only element in an array leaves parent valid', () => {
    const code = 'const a = [42];';
    const expected = 'const a = [];';
    const arb = new Arborist(code);
    const literal = arb.ast.find(n => n.type === 'Literal');
    arb.markNode(literal);
    arb.applyChanges();
    assert.equal(arb.script, expected);
  });

  it('Multiple changes in a single pass (replace and delete siblings)', () => {
    const code = 'let a = 1, b = 2, c = 3;';
    const expected = 'let a = 10, c = 3;';
    const arb = new Arborist(code);
    const bDecl = arb.ast.find(n => n.type === 'VariableDeclarator' && n.id.name === 'b');
    const aDecl = arb.ast.find(n => n.type === 'VariableDeclarator' && n.id.name === 'a');
    arb.markNode(bDecl); // delete b
    arb.markNode(aDecl.init, {type: 'Literal', value: 10, raw: '10'}); // replace a's value
    arb.applyChanges();
    assert.equal(arb.script, expected);
  });

  it('Does not treat a replaced declarator as a deleted declarator', () => {
    const arb = new Arborist('let a = 1, b = 2;');
    const aDecl = arb.ast.find(n => n.type === 'VariableDeclarator' && n.id.name === 'a');
    const bDecl = arb.ast.find(n => n.type === 'VariableDeclarator' && n.id.name === 'b');

    arb.replaceNode(aDecl, {
      type: 'VariableDeclarator',
      id: {type: 'Identifier', name: 'a'},
      init: {type: 'Literal', value: 10, raw: '10'},
    });
    arb.deleteNode(bDecl);

    assert.equal(arb.applyChanges(), 2);
    assert.equal(arb.script, 'let a = 10;');
  });

  it('Deeply nested node replacement', () => {
    const code = 'if (a) { if (b) { c(); } }';
    const expected = `if (a) {
  if (b) {
    d();
  }
}`;
    const arb = new Arborist(code);
    const cCall = arb.ast.find(n => n.type === 'Identifier' && n.name === 'c');
    arb.markNode(cCall, {type: 'Identifier', name: 'd'});
    arb.applyChanges();
    assert.equal(arb.script, expected);
  });

  it('Multiple comments on a node being deleted', () => {
    const code = '// lead1\n// lead2\nconst a = 1; // trail1\n// trail2\nconst b = 2;';
    const expected = '// lead1\n// lead2\nconst a = 1;  // trail1\n              // trail2';
    const arb = new Arborist(code);
    const bDecl = arb.ast.find(n => n.type === 'VariableDeclaration' && n.declarations[0].id.name === 'b');
    arb.markNode(bDecl);
    arb.applyChanges();
    assert.equal(arb.script.trim(), expected.trim());
  });

  it('Marking the same node for deletion and replacement only applies one change', () => {
    const code = 'let x = 1;';
    const expected = 'let x = 2;';
    const arb = new Arborist(code);
    const literal = arb.ast.find(n => n.type === 'Literal');
    arb.markNode(literal, {type: 'Literal', value: 2, raw: '2'});
    arb.markNode(literal); // Should not delete after replacement
    arb.applyChanges();
    assert.equal(arb.script, expected);
  });

  it('Replacement failures are isolated and later replacements still apply', () => {
    const code = 'let a = 1, b = 2;';
    const arb = new Arborist(code);
    const aLiteral = arb.ast.find(n => n.type === 'Literal' && n.value === 1);
    const bLiteral = arb.ast.find(n => n.type === 'Literal' && n.value === 2);
    arb.markNode(aLiteral, {type: 'Literal', value: 10, raw: '10'});
    arb.markNode(bLiteral, {type: 'Literal', value: 20, raw: '20'});
    aLiteral.parentNode = null;

    const numberOfChangesMade = arb.applyChanges();

    assert.equal(numberOfChangesMade, 1, 'A failed replacement should not count as applied');
    assert.equal(arb.script, 'let a = 1, b = 20;', 'A failed replacement prevented later valid replacements');
  });

  it('A detached array child is not counted as replaced', () => {
    const arb = new Arborist('call(1, 2);');
    const call = arb.ast.find(n => n.type === 'CallExpression');
    const target = call.arguments[0];
    call.arguments.shift();
    arb.replaceNode(target, {type: 'Literal', value: 10});

    assert.equal(arb.applyChanges(), 0, 'A detached node was counted as replaced');
    assert.equal(call.arguments[-1], undefined, 'The replacement was written to an invalid array property');
  });

  it('applyChanges returns 0 when an outer failure occurs', () => {
    const arb = new Arborist('const a = 1;');
    const originalScript = arb.script;
    const originalAst = arb.ast;
    const throwingReplacement = {};
    Object.defineProperty(throwingReplacement, 'body', {
      get() {
        throw new Error('boom');
      },
    });
    arb.markNode(arb.ast[0], throwingReplacement);

    const numberOfChangesMade = arb.applyChanges();

    assert.equal(numberOfChangesMade, 0, 'Outer applyChanges failures should be reported as 0 changes');
    assert.equal(arb.script, originalScript, 'Script changed despite outer applyChanges failure');
    assert.equal(arb.ast, originalAst, 'AST changed despite outer applyChanges failure');
  });

  it('AST is still valid and mutable after applyChanges', () => {
    const code = 'let y = 5;';
    const arb = new Arborist(code);
    const literal = arb.ast.find(n => n.type === 'Literal');
    arb.markNode(literal, {type: 'Literal', value: 10, raw: '10'});
    arb.applyChanges();
    assert.equal(arb.script, 'let y = 10;'); // Validate the change was applied
    // Now change again
    const newLiteral = arb.ast.find(n => n.type === 'Literal');
    arb.markNode(newLiteral, {type: 'Literal', value: 20, raw: '20'});
    arb.applyChanges();
    assert.equal(arb.script, 'let y = 20;');
  });

  it('A node will not marked if any of their ancestors is', () => {
    const code = 'const arr = [1, 2, 3];';
    const arb = new Arborist(code);
    const arrayNode = arb.ast.find((n) => n.type === 'ArrayExpression');
    const literals = arb.ast.filter((n) => n.type === 'Literal');
    arb.markNode(arrayNode);
    for (const lit of literals) {arb.markNode(lit);}
    assert.ok(arrayNode.isMarked);
    for (const lit of literals) {assert.ok(!lit.isMarked);}
  });

  it('Batches sibling deletions without losing comments', () => {
    const code = Array.from({length: 200}, (_, i) => `// comment-${i}\ncall(${i});`).join('\n');
    const arb = new Arborist(code);
    const deletedStatements = arb.ast[0].body.slice(0, 160);
    for (const statement of deletedStatements) arb.deleteNode(statement);

    assert.equal(arb.applyChanges(), 160);
    assert.equal(arb.ast[0].body.length, 40);
    assert.equal(arb.ast[0].body[0].expression.arguments[0].value, 160);
    for (let i = 0; i < 160; i++) assert.ok(arb.script.includes(`// comment-${i}`));
  });

  it('Batches sibling replacements without losing comments', () => {
    const code = Array.from({length: 200}, (_, i) => `// comment-${i}\ncall(${i});`).join('\n');
    const arb = new Arborist(code);
    const replacedStatements = arb.ast[0].body.slice(0, 160);
    for (const statement of replacedStatements) arb.replaceNode(statement, {type: 'EmptyStatement'});

    assert.equal(arb.applyChanges(), 160);
    assert.equal(arb.ast[0].body.length, 200);
    assert.ok(arb.ast[0].body.slice(0, 160).every(node => node.type === 'EmptyStatement'));
    for (let i = 0; i < 160; i++) assert.ok(arb.script.includes(`// comment-${i}`));
  });

  it('Indexes medium ordered runs of adjacent sibling replacements', () => {
    const code = Array.from({length: 48}, (_, i) => `call(${i});`).join('\n');
    const arb = new Arborist(code);
    const replacedStatements = arb.ast[0].body.slice(16, 48);
    for (const statement of replacedStatements) arb.replaceNode(statement, {type: 'EmptyStatement'});

    assert.equal(arb.applyChanges(), 32);
    assert.equal(arb.ast[0].body.length, 48);
    assert.ok(arb.ast[0].body.slice(0, 16).every(node => node.type === 'ExpressionStatement'));
    assert.ok(arb.ast[0].body.slice(16).every(node => node.type === 'EmptyStatement'));
  });

  it('Preserves sparse array holes during batched deletions', () => {
    const values = Array.from({length: 160}, (_, i) => i === 140 ? '' : i).join(',');
    const arb = new Arborist(`[${values}];`);
    const deletedElements = arb.ast.find(node => node.type === 'ArrayExpression').elements
      .filter(Boolean)
      .slice(0, 128);
    for (const element of deletedElements) arb.deleteNode(element);

    assert.equal(arb.applyChanges(), 128);
    const elements = arb.ast.find(node => node.type === 'ArrayExpression').elements;
    assert.equal(elements.length, 32);
    assert.equal(elements.filter(Boolean).length, 31);
  });

  it('Preserves script source type after applying changes', () => {
    const arb = new Arborist('with (target) { value = 1; }');
    const literal = arb.ast.find(node => node.type === 'Literal');
    arb.replaceNode(literal, {type: 'Literal', value: 2, raw: '2'});

    assert.equal(arb.applyChanges(), 1);
    assert.equal(arb.ast[0].sourceType, 'script');
    assert.match(arb.script, /value = 2/);
  });

  it('Preserves flat AST generation options across rebuilds', () => {
    const arb = new Arborist('// keep this comment\nconst value = 1;', {
      compactScopes: true,
      retainTokens: false,
    });
    const literal = arb.ast.find(node => node.type === 'Literal');
    assert.equal(arb.ast[0].tokens, undefined);
    arb.replaceNode(literal, {type: 'Literal', value: 2, raw: '2'});

    assert.equal(arb.applyChanges(), 1);
    assert.equal(arb.ast[0].tokens, undefined);
    assert.ok(Object.values(arb.ast[0].allScopes).every(scope => !('set' in scope) && !('through' in scope)));
    assert.match(arb.script, /keep this comment/);
  });

  it('Reuses compact metadata for safe literal replacements', () => {
    const code = 'const outer = 1; function read(value) { const local = 2; return outer + value + local; }';
    const options = {compactScopes: true, retainTokens: false};
    const arb = new Arborist(code, options);
    const literal = arb.ast.find(node => node.type === 'Literal' && node.value === 2);
    arb.replaceNode(literal, {type: 'Literal', value: 3, raw: '3'});

    assert.equal(arb.applyChanges(), 1);
    const oracle = generateFlatAST(arb.script, options);
    assert.deepEqual(summarizeDetailedNodes(arb.ast), summarizeDetailedNodes(oracle));
    assert.deepEqual(summarizeDetailedScopes(arb.ast), summarizeDetailedScopes(oracle));
    assert.ok(arb.ast.every((node, index) => node.nodeId === index && arb.ast[node.nodeId] === node));
  });

  it('Fully rebuilds metadata for identifier replacements', () => {
    const arb = new Arborist('let first = 1, second = 2; first;', {compactScopes: true});
    const reference = arb.ast.find(node => node.type === 'Identifier' && node.name === 'first' && node.declNode);
    arb.replaceNode(reference, {type: 'Identifier', name: 'second'});

    assert.equal(arb.applyChanges(), 1);
    const updatedReference = arb.ast.find(node => node.type === 'Identifier' && node.name === 'second' && node.declNode);
    assert.equal(updatedReference.declNode.name, 'second');
    assert.equal(updatedReference.parentNode.type, 'ExpressionStatement');
  });

  it('Reuses compact metadata for operator-only replacements', () => {
    const code = 'let left = 1, right = 2, count = 0; left + right; left && right; left += right; count++;';
    const options = {compactScopes: true, retainTokens: false};
    const arb = new Arborist(code, options);
    const replacements = {
      BinaryExpression: '-',
      LogicalExpression: '||',
      AssignmentExpression: '-=',
      UpdateExpression: '--',
    };
    for (const [type, operator] of Object.entries(replacements)) {
      const target = arb.ast.find(node => node.type === type);
      const replacement = {type, operator};
      if (type === 'UpdateExpression') {
        replacement.argument = target.argument;
        replacement.prefix = target.prefix;
      } else {
        replacement.left = target.left;
        replacement.right = target.right;
      }
      arb.replaceNode(target, replacement);
    }

    assert.equal(arb.applyChanges(), 4);
    const oracle = generateFlatAST(arb.script, options);
    assert.deepEqual(summarizeDetailedNodes(arb.ast), summarizeDetailedNodes(oracle));
    assert.deepEqual(summarizeDetailedScopes(arb.ast), summarizeDetailedScopes(oracle));
    assert.ok(arb.ast.every((node, index) => node.nodeId === index && arb.ast[node.nodeId] === node));
  });

  it('Preserves comments when metadata reuse requires rich parsing', () => {
    const code = '// file header\nconst value = 1; // retained';
    const options = {compactScopes: true, retainTokens: false};
    const arb = new Arborist(code, options);
    const literal = arb.ast.find(node => node.type === 'Literal');
    arb.replaceNode(literal, {type: 'Literal', value: 2, raw: '2'});

    assert.equal(arb.applyChanges(), 1);
    assert.match(arb.script, /file header/);
    assert.match(arb.script, /retained/);
    assert.equal(arb.ast[0].tokens, undefined);
  });

  it('Detects attached comments when the parser comment list is unavailable', () => {
    const code = '// file header\nconst value = 1;';
    const options = {compactScopes: true, retainTokens: false};
    const ast = generateFlatAST(code, options);
    delete ast[0].comments;
    const arb = new Arborist(ast, options);
    const literal = arb.ast.find(node => node.type === 'Literal');
    arb.replaceNode(literal, {type: 'Literal', value: 2, raw: '2'});

    assert.equal(arb.applyChanges(), 1);
    assert.match(arb.script, /file header/);
  });

  it('Retains tokens when metadata reuse is configured to keep them', () => {
    const arb = new Arborist('const value = 1;', {compactScopes: true});
    const literal = arb.ast.find(node => node.type === 'Literal');
    arb.replaceNode(literal, {type: 'Literal', value: 2, raw: '2'});

    assert.equal(arb.applyChanges(), 1);
    assert.ok(arb.ast[0].tokens.length > 0);
  });

  it('Preserves script mode during lean metadata reuse', () => {
    const arb = new Arborist('with (target) { value = 1; }', {
      compactScopes: true,
      retainTokens: false,
    });
    const literal = arb.ast.find(node => node.type === 'Literal');
    arb.replaceNode(literal, {type: 'Literal', value: 2, raw: '2'});

    assert.equal(arb.applyChanges(), 1);
    assert.equal(arb.ast[0].sourceType, 'script');
    assert.equal(arb.ast[0].tokens, undefined);
    assert.match(arb.script, /value = 2/);
  });
});
