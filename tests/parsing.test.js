import assert from 'node:assert';
import {describe, it} from 'node:test';
import {extractNodesFromRoot, generateFlatAST, generateCode, parseCode} from '../src/index.js';

describe('Parsing tests', () => {
  it('Verify the function-expression-name scope is always replaced with its child scope', () => {
    const code = `
(function test(p) {
  let i = 1;
  i;
})();`;
    const ast = generateFlatAST(code);
    const testedScope = ast[0].allScopes[Object.keys(ast[0].allScopes).slice(-1)[0]];
    const expectedParentScopeType = 'function-expression-name';
    const expectedScopeType = 'function';
    // ast.slice(-1)[0].type is the last identifier in the code and should have the expected scope type
    assert.equal(ast.slice(-1)[0].scope.type, expectedScopeType, 'Unexpected scope');
    assert.equal(testedScope.upper.type, expectedParentScopeType, 'Tested scope is not the child of the correct scope');
  });
  it('Verify declNode references the local declaration correctly', () => {
    const innerScopeVal = 'inner';
    const outerScopeVal = 'outer';
    const code = `var a = '${outerScopeVal}';
			if (true) {
				let a = '${innerScopeVal}';
				console.log(a);
			}
			console.log(a);`;
    const ast = generateFlatAST(code);
    const [innerIdentifier, outerIdentifier] = ast.filter(n => n.type === 'Identifier' && n.parentNode.type === 'CallExpression');
    const innerValResult = innerIdentifier.declNode.parentNode.init.value;
    const outerValResult = outerIdentifier.declNode.parentNode.init.value;
    assert.equal(innerValResult, innerScopeVal, 'Declaration node (inner scope) is incorrectly referenced.');
    assert.equal(outerValResult, outerScopeVal, 'Declaration node (outer scope) is incorrectly referenced.');
  });
  it('Verify repeated references resolve declarations from an outer scope', () => {
    const ast = generateFlatAST('const outer = 1; function read() { return outer + outer; }');
    const declaration = ast.find(n => n.type === 'Identifier' && n.name === 'outer' && n.parentKey === 'id');
    const references = ast.filter(n => n.type === 'Identifier' && n.name === 'outer' && n.declNode);

    assert.equal(references.length, 2);
    assert.ok(references.every(node => node.declNode === declaration));
    assert.deepEqual(declaration.references, references);
  });
  it('Verify distinct references resolve declarations from an outer scope', () => {
    const ast = generateFlatAST('const first = 1, second = 2; function read() { return first + second; }');
    const declarations = new Map(ast
      .filter(n => n.type === 'Identifier' && n.parentKey === 'id')
      .map(n => [n.name, n]));
    const references = ast.filter(n => n.type === 'Identifier' && ['first', 'second'].includes(n.name) && n.declNode);

    assert.equal(references.length, 2);
    assert.ok(references.every(node => node.declNode === declarations.get(node.name)));
  });
  it('Verify a function\'s identifier isn\'t treated as a reference', () => {
    const code = `function a() {
			var a;
			}`;
    const ast = generateFlatAST(code);
    const funcId = ast.find(n => n.name ==='a' && n.parentNode.type === 'FunctionDeclaration');
    const varId = ast.find(n =>n.name ==='a' && n.parentNode.type === 'VariableDeclarator');
    const functionReferencesFound = !!funcId.references?.length;
    const variableReferencesFound = !!varId.references?.length;
    assert.ok(!functionReferencesFound, 'References to a function were incorrectly found');
    assert.ok(!variableReferencesFound, 'References to a variable were incorrectly found');
  });
  it('Verify proper handling of class properties', () => {
    const code = `class a {
  static b = 1;
  #c = 2;
}`;
    const expected = code;
    const ast = generateFlatAST(code);
    const result = generateCode(ast[0]);
    assert.strictEqual(result, expected);
  });
  it('Verify the type map is generated accurately', () => {
    const code = `class a {
  static b = 1;
  #c = 2;
}`;
    const ast = generateFlatAST(code);
    const expected = {
      Program: [ast[0]],
      ClassDeclaration: [ast[1]],
      Identifier: [ast[2], ast[5]],
      ClassBody: [ast[3]],
      PropertyDefinition: [ast[4], ast[7]],
      Literal: [ast[6], ast[9]],
      PrivateIdentifier: [ast[8]],
    };
    const result = ast[0].typeMap;
    const resultEntries = Object.entries(result)
      .filter(([type, nodes]) => type !== 'typeList' && Array.isArray(nodes));
    assert.deepEqual(Object.fromEntries(resultEntries), expected);
  });
  it('Verify the type list contains all parsed node types without duplicates', () => {
    const code = `class a {
  static b = 1;
  #c = 2;
}`;
    const ast = generateFlatAST(code);
    const expectedTypes = [
      'Program',
      'ClassDeclaration',
      'Identifier',
      'ClassBody',
      'PropertyDefinition',
      'Literal',
      'PrivateIdentifier',
    ];
    assert.deepEqual(ast[0].typeMap.typeList, expectedTypes);
    assert.equal(ast[0].typeMap.typeList.length, new Set(ast[0].typeMap.typeList).size);
  });
  it('Verify node relations include stable parent-child links and traversal order', () => {
    const code = 'for (var i = 0; i < 10; i++);\nfor (var i = 0; i < 10; i++);';
    const ast = generateFlatAST(code);
    const [firstLoop, secondLoop] = ast.filter(n => n.type === 'ForStatement');
    assert.equal(firstLoop.parentNode, ast[0], 'First loop parent node is incorrect');
    assert.equal(secondLoop.parentNode, ast[0], 'Second loop parent node is incorrect');
    assert.equal(firstLoop.parentKey, 'body', 'First loop parent key is incorrect');
    assert.equal(secondLoop.parentKey, 'body', 'Second loop parent key is incorrect');
    assert.deepEqual(ast[0].body, [firstLoop, secondLoop], 'Program body order does not match traversal order');
    assert.deepEqual(ast[0].childNodes.slice(0, 2), [firstLoop, secondLoop], 'Program childNodes order is unstable');
  });
  it('Verify every nodeId matches its flat AST array index', () => {
    const fixtures = [
      generateFlatAST('const source = {value}; ({value = 1} = source);'),
      generateFlatAST('const pattern = /test/gi;', {
        parseOpts: {sourceType: 'module', comment: true, tokens: true, loc: true},
      }),
      generateFlatAST('function test(value) { return value + 1; }', {detailed: false, includeSrc: false}),
    ];

    for (const ast of fixtures) {
      ast.forEach((node, index) => {
        assert.equal(node.nodeId, index, `Node at index ${index} has nodeId ${node.nodeId}`);
        assert.equal(ast[node.nodeId], node, `nodeId ${node.nodeId} does not resolve to the same node`);
      });
    }
  });
  it('Verify benchmark phase timing does not change extraction results', () => {
    const code = 'const outer = 1; function read(value) { return outer + value; }';
    const options = {detailed: true, includeSrc: true};
    const rootNode = parseCode(code, {sourceType: 'module', comment: true, tokens: true});
    const timedRootNode = parseCode(code, {sourceType: 'module', comment: true, tokens: true});
    rootNode.src = code;
    timedRootNode.src = code;
    const expected = extractNodesFromRoot(rootNode, options);
    const timings = {};
    const actual = extractNodesFromRoot(timedRootNode, options, timings);
    const summarize = ast => ast.map(node => ({
      type: node.type,
      nodeId: node.nodeId,
      parentId: node.parentNode?.nodeId,
      ancestry: node.ancestry,
      lineage: node.lineage,
      src: node.src,
      declarationId: node.declNode?.nodeId,
      referenceIds: node.references?.map(reference => reference.nodeId),
    }));

    assert.deepEqual(summarize(actual), summarize(expected));
    assert.ok(actual.every((node, index) => node.nodeId === index && actual[node.nodeId] === node));
    assert.ok(timings.scopeAnalysis >= 0);
    assert.ok(timings.flatteningAndDecoration >= 0);
    assert.ok(timings.identifierLinking >= 0);
  });
  it('Verify compact scopes preserve documented relationships', () => {
    const code = 'const outer = 1; (function named(param) { let local = outer; return param + local; })();';
    const expected = generateFlatAST(code);
    const actual = generateFlatAST(code, {compactScopes: true});
    const summarizeNodes = ast => ast.map(node => ({
      type: node.type,
      nodeId: node.nodeId,
      scopeId: node.scope?.scopeId,
      scopeType: node.scope?.type,
      declarationId: node.declNode?.nodeId,
      referenceIds: node.references?.map(reference => reference.nodeId),
    }));
    const summarizeScopes = ast => Object.values(ast[0].allScopes).map(scope => ({
      scopeId: scope.scopeId,
      type: scope.type,
      blockId: scope.block.nodeId,
      upperId: scope.upper?.scopeId,
      upperType: scope.upper?.type,
      childScopes: scope.childScopes.map(child => [child.scopeId, child.type]),
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

    assert.deepEqual(summarizeNodes(actual), summarizeNodes(expected));
    assert.deepEqual(summarizeScopes(actual), summarizeScopes(expected));
    assert.ok(actual.every((node, index) => node.nodeId === index && actual[node.nodeId] === node));
    assert.ok(Object.values(actual[0].allScopes).every(scope => !('set' in scope) && !('through' in scope)));
  });
  it('Verify the module scope is ignored', () => {
    const code = 'function a() {return [1];}\nconst b = a();';
    const ast = generateFlatAST(code);
    ast.forEach(n => assert.ok(n.scope.type !== 'module', 'Module scope was not ignored'));
    assert.deepEqual(ast[0].allScopes[0].variables.map(variable => variable.name), ['a', 'b'],
      'Module variables were not merged into the global scope exactly once');
  });
  it('Verify the lineage is correct', () => {
    const code = '(function() {var a; function b() {var c;}})();';
    const ast = generateFlatAST(code);
    function extractLineage(node) {
      const lineage = [];
      let currentNode = node;
      while (currentNode) {
        lineage.push(currentNode.scope.scopeId);
        if (!currentNode.scope.scopeId) break;
        currentNode = currentNode.parentNode;
      }
      return [...new Set(lineage)].reverse();
    }
    ast[0].typeMap.Identifier.forEach(n => {
      const extractedLineage = extractLineage(n);
      assert.deepEqual(n.lineage, extractedLineage);
    });
  });
  it('Verify the ancestry is correct', () => {
    const code = '(function() {var a; if (true) { function b() {var c; c;} } a;})()';
    const ast = generateFlatAST(code);
    function extractAncestry(node) {
      const ancestry = [];
      let currentNode = node.parentNode;
      while (currentNode) {
        ancestry.unshift(currentNode.nodeId);
        currentNode = currentNode.parentNode;
      }
      return ancestry;
    }
    ast.forEach(node => {
      assert.deepEqual(node.ancestry, extractAncestry(node), `Unexpected ancestry for node #${node.nodeId}`);
    });

    const programNode = ast[0];
    const nestedReference = ast.find(n => n.type === 'Identifier' && n.name === 'c' && n.declNode);
    const topLevelReference = ast.filter(n => n.type === 'Identifier' && n.name === 'a' && n.declNode).slice(-1)[0];
    assert.ok(nestedReference.ancestry.includes(programNode.nodeId), 'Nested node should include the Program node in its ancestry.');
    assert.ok(!topLevelReference.ancestry.includes(nestedReference.parentNode.nodeId), 'Sibling branch should not include an unrelated ancestor nodeId.');
  });
  it('Verify sparse array holes do not create bogus child nodes', () => {
    const code = '[,,,].join(\'-\');';
    const ast = generateFlatAST(code);
    const arrayNode = ast.find(n => n.type === 'ArrayExpression');
    assert.ok(arrayNode, 'ArrayExpression was not parsed');
    assert.equal(arrayNode.elements.length, 3, 'Sparse array hole count changed');
    assert.equal(arrayNode.elements.filter(Boolean).length, 0, 'Sparse array holes were materialized as child nodes');
    assert.deepEqual(arrayNode.childNodes, [], 'Sparse array holes should not become childNodes');
    assert.equal(ast.length, 7, 'Unexpected node count for sparse array traversal');
    assert.deepEqual(ast.map(n => n.type), [
      'Program',
      'ExpressionStatement',
      'CallExpression',
      'MemberExpression',
      'ArrayExpression',
      'Identifier',
      'Literal',
    ], 'Unexpected traversal output for sparse array holes');
  });
  it('Verify sibling nodes with the same start offset are not dropped', () => {
    const ast = generateFlatAST('const source = {value}; ({value = 1} = source);');
    const properties = ast.filter(n => n.type === 'Property');

    assert.equal(properties.length, 2, 'Unexpected number of properties');
    assert.deepEqual(properties.map(n => n.childNodes.map(child => child.type)), [
      ['Identifier', 'Identifier'],
      ['Identifier', 'AssignmentPattern'],
    ], 'A child sharing its sibling\'s start offset was dropped');
    assert.equal(ast.filter(n => n.type === 'Identifier' && n.name === 'value').length, 4,
      'The flat AST omitted identifiers at duplicate source offsets');
  });
  it('Verify regular expression metadata is not flattened as AST nodes', () => {
    const ast = generateFlatAST('const pattern = /test/gi;');
    const literal = ast.find(n => n.type === 'Literal');

    assert.deepEqual(ast.map(n => n.type), [
      'Program',
      'VariableDeclaration',
      'VariableDeclarator',
      'Identifier',
      'Literal',
    ]);
    assert.equal(literal.regex.pattern, 'test');
    assert.equal(literal.regex.flags, 'gi');
    assert.ok(literal.value instanceof RegExp);
  });
  it('Verify location metadata is preserved without becoming AST nodes', () => {
    const ast = generateFlatAST('const value = 1;', {
      parseOpts: {sourceType: 'module', comment: true, tokens: true, loc: true},
    });

    assert.equal(ast.length, 5, 'Location metadata created bogus flat nodes');
    assert.ok(ast.every(n => typeof n.type === 'string'), 'A flattened item is not an AST node');
    assert.deepEqual(ast[0].loc.start, {line: 1, column: 0});
  });
  it('Verify unknown node types use reflective child discovery', () => {
    const rootNode = {
      type: 'CustomRoot',
      start: 0,
      end: 1,
      payload: {type: 'Identifier', name: 'value', start: 0, end: 1},
    };

    const ast = extractNodesFromRoot(rootNode, {detailed: false, includeSrc: false});

    assert.deepEqual(ast.map(node => node.type), ['CustomRoot', 'Identifier']);
    assert.equal(ast[1].parentNode, ast[0]);
    assert.equal(ast[1].parentKey, 'payload');
  });
  it('Verify large flat scripts do not overflow traversal', () => {
    const stmt = 'var x = 1;\n';
    const code = stmt.repeat(Math.ceil((2 * 1024 * 1024) / stmt.length));
    let ast = [];
    let error = '';
    try {
      ast = generateFlatAST(code);
    } catch (e) {
      error = e.message;
    }
    assert.ok(ast.length, `Large script was not parsed.${error ? ` Error: ${error}` : ''}`);
  });
  it('Verify deeply nested ASTs do not overflow traversal', () => {
    const depth = 20000;
    const rootNode = {type: 'Program', start: 0, end: 0, sourceType: 'script', body: []};
    const expressionStatement = {type: 'ExpressionStatement', start: 0, end: 0};
    rootNode.body.push(expressionStatement);
    expressionStatement.expression = {type: 'UnaryExpression', start: 0, end: 0, operator: '!', prefix: true};
    let currentNode = expressionStatement.expression;
    for (let i = 1; i < depth; i++) {
      const child = {type: 'UnaryExpression', start: 0, end: 0, operator: '!', prefix: true};
      currentNode.argument = child;
      currentNode = child;
    }

    const ast = extractNodesFromRoot(rootNode, {detailed: false, includeSrc: false});

    assert.equal(ast.length, depth + 2);
    assert.equal(ast.at(-1).nodeId, depth + 1);
    assert.ok(ast.every((node, index) => node.nodeId === index));
  });
  it('Verify all identifiers are referenced correctly', () => {
    const code = 'let a = 1; switch(a) {case 1: a;}';
    const ast = generateFlatAST(code);
    ast.filter(n => n.type === 'Identifier').forEach(n => {
      assert.ok(n.references?.length || n.declNode, `Identifier '${n.name}' (#${n.nodeId}) is not referenced`);
    });
  });
  it('Links identifiers whose names match Object prototype properties', () => {
    const ast = generateFlatAST(`
      let constructor = 1, toString = 2, __proto__ = 3;
      constructor; toString; __proto__;
    `);

    for (const name of ['constructor', 'toString', '__proto__']) {
      const declaration = ast[0].typeMap.Identifier.find(node => node.name === name && node.parentKey === 'id');
      assert.equal(declaration.references.length, 1, `Unexpected reference count for ${name}`);
      assert.equal(declaration.references[0].declNode, declaration, `Reference did not resolve to ${name}`);
    }
  });
});
