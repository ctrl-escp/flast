import assert from 'node:assert';
import {describe, it} from 'node:test';
import {applyIteratively, applyIterativelyAsync, Arborist, logger} from '../src/index.js';
describe('Utils tests: applyIteratively', () => {
  it('Verify applyIteratively cannot remove the root node without replacing it', () => {
    const code = 'a';
    const expectedOutput = code;
    const removeRoot = function removeRoot(arb) {
      for (let i = 0; i < arb.ast.length; i++) {
        const n = arb.ast[i];
        if (n.type === 'Program') {
          arb.markNode(n);
        }
      }
      return arb;
    };
    const result = applyIteratively(code, [removeRoot]);

    assert.equal(result, expectedOutput, 'Result does not match expected output');
  });
  it('Verify applyIteratively catches a critical exception', () => {
    const code = 'a';
    // noinspection JSCheckFunctionSignatures
    const result = applyIteratively(code, {length: 4});
    assert.equal(result, code, 'Result does not match expected output');
  });
  it('Verify applyIteratively works as expected', () => {
    const code = 'console.log(\'Hello\' + \' \' + \'there\');';
    const expectedOutput = 'console.log(\'General\' + \' \' + \'Kenobi\');';
    const replacements = {
      Hello: 'General',
      there: 'Kenobi',
    };
    let result = code;
    const replaceLiterals = function replaceLiterals(arb) {
      for (let i = 0; i < arb.ast.length; i++) {
        const n = arb.ast[i];
        if (n.type === 'Literal' && replacements[n.value]) {
          arb.markNode(n, {
            type: 'Literal',
            value: replacements[n.value],
          });
        }
      }
      return arb;
    };
    result = applyIteratively(result, [replaceLiterals]);

    assert.equal(result, expectedOutput, 'Result does not match expected output');
  });
  it('Verify applyIteratively continues after a modifier throws', () => {
    const code = 'const greeting = \'Hello\';';
    const throwingModifier = function throwingModifier() {
      throw new Error('boom');
    };
    const replaceLiteral = function replaceLiteral(arb) {
      for (let i = 0; i < arb.ast.length; i++) {
        const n = arb.ast[i];
        if (n.type === 'Literal' && n.value === 'Hello') {
          arb.markNode(n, {type: 'Literal', value: 'General', raw: '\'General\''});
        }
      }
      return arb;
    };

    const result = applyIteratively(code, [throwingModifier, replaceLiteral]);

    assert.equal(result, 'const greeting = \'General\';', 'Later modifiers did not run after an earlier modifier threw');
  });
  it('Verify applyIteratively detects a replaced Arborist by identity', () => {
    const code = 'const greeting = \'Hello\';';
    const replaceWithNewArborist = function replaceWithNewArborist(arb) {
      const nextArb = new arb.constructor(arb.script);
      for (let i = 0; i < nextArb.ast.length; i++) {
        const n = nextArb.ast[i];
        if (n.type === 'Literal' && n.value === 'Hello') {
          nextArb.markNode(n, {type: 'Literal', value: 'General', raw: '\'General\''});
        }
      }
      return nextArb;
    };

    const result = applyIteratively(code, [replaceWithNewArborist], 2);

    assert.equal(result, 'const greeting = \'General\';', 'Replaced Arborist instance was not applied');
  });
  it('Batches independent modifiers into one rebuild per iteration', () => {
    const code = 'const values = [1, 2, 3];';
    let observedArborist;
    const modifiers = [1, 2, 3].map(value => function replaceValue(arb) {
      observedArborist = arb;
      const target = arb.ast.find(node => node.type === 'Literal' && node.value === value);
      if (target) arb.replaceNode(target, {type: 'Literal', value: value * 10, raw: String(value * 10)});
      return arb;
    });

    const result = applyIteratively(code, modifiers, {
      mode: 'batch',
      arboristOptions: {compactScopes: true, retainTokens: false},
    });

    assert.equal(result, 'const values = [\n  10,\n  20,\n  30\n];');
    assert.equal(observedArborist.appliedCounter, 1, 'Batch mode rebuilt more than once');
  });
  it('Keeps sequential same-pass visibility for dependent modifiers', () => {
    const code = 'const value = 1;';
    const replaceOne = function replaceOne(arb) {
      const target = arb.ast.find(node => node.type === 'Literal' && node.value === 1);
      if (target) arb.replaceNode(target, {type: 'Literal', value: 2, raw: '2'});
      return arb;
    };
    const replaceTwo = function replaceTwo(arb) {
      const target = arb.ast.find(node => node.type === 'Literal' && node.value === 2);
      if (target) arb.replaceNode(target, {type: 'Literal', value: 3, raw: '3'});
      return arb;
    };

    assert.equal(applyIteratively(code, [replaceOne, replaceTwo], 1), 'const value = 3;');
    assert.equal(applyIteratively(code, [replaceOne, replaceTwo], {mode: 'batch', maxIterations: 1}),
      'const value = 2;');
  });
  it('Can preview and override iterative next-major defaults', () => {
    const code = 'const value = 1;';
    const observedOptions = [];
    const replaceOne = function replaceOne(arb) {
      observedOptions.push({...arb.options});
      const target = arb.ast.find(node => node.type === 'Literal' && node.value === 1);
      if (target) arb.replaceNode(target, {type: 'Literal', value: 2, raw: '2'});
      return arb;
    };
    const replaceTwo = function replaceTwo(arb) {
      const target = arb.ast.find(node => node.type === 'Literal' && node.value === 2);
      if (target) arb.replaceNode(target, {type: 'Literal', value: 3, raw: '3'});
      return arb;
    };

    assert.equal(applyIteratively(code, [replaceOne, replaceTwo], {
      nextMajorDefaults: true,
      maxIterations: 1,
    }), 'const value = 2;');
    assert.deepEqual(observedOptions[0], {compactScopes: true, retainTokens: false});

    assert.equal(applyIteratively(code, [replaceOne, replaceTwo], {
      nextMajorDefaults: true,
      mode: 'sequential',
      maxIterations: 1,
      arboristOptions: {compactScopes: false, retainTokens: true},
    }), 'const value = 3;');
    assert.deepEqual(observedOptions[1], {compactScopes: false, retainTokens: true});
  });
  it('Can preview next-major defaults through the environment', () => {
    const originalValue = process.env.FLAST_NEXT_MAJOR_DEFAULTS;
    let observedOptions;
    const inspectOptions = function inspectOptions(arb) {
      observedOptions = arb.options;
      return arb;
    };

    try {
      process.env.FLAST_NEXT_MAJOR_DEFAULTS = '1';
      applyIteratively('const value = 1;', [inspectOptions], 1);
      assert.deepEqual(observedOptions, {compactScopes: true, retainTokens: false});

      observedOptions = null;
      applyIteratively('const value = 1;', [inspectOptions], {
        nextMajorDefaults: false,
        maxIterations: 1,
      });
      assert.deepEqual(observedOptions, {nextMajorDefaults: false});
    } finally {
      if (originalValue === undefined) delete process.env.FLAST_NEXT_MAJOR_DEFAULTS;
      else process.env.FLAST_NEXT_MAJOR_DEFAULTS = originalValue;
    }
  });
  it('Continues a batch after an ordinary modifier exception', () => {
    const code = 'const values = [1, 2];';
    const throwingModifier = function throwingModifier(arb) {
      const target = arb.ast.find(node => node.type === 'Literal' && node.value === 1);
      arb.replaceNode(target, {type: 'Literal', value: 10, raw: '10'});
      throw new Error('cleanup failed');
    };
    const laterModifier = function laterModifier(arb) {
      const target = arb.ast.find(node => node.type === 'Literal' && node.value === 2);
      arb.replaceNode(target, {type: 'Literal', value: 20, raw: '20'});
      return arb;
    };

    assert.equal(applyIteratively(code, [throwingModifier, laterModifier], {mode: 'batch', maxIterations: 1}),
      'const values = [\n  10,\n  20\n];');
  });
  it('Preserves markNode overlap rules across batched modifiers', () => {
    const createReplacement = value => function replaceLiteral(arb) {
      const target = arb.ast.find(node => node.type === 'Literal');
      arb.replaceNode(target, {type: 'Literal', value, raw: String(value)});
      return arb;
    };

    assert.equal(applyIteratively('const value = 1;', [createReplacement(2), createReplacement(3)], {
      mode: 'batch',
      maxIterations: 1,
    }), 'const value = 2;');
  });
  it('Rejects a replacement Arborist that would discard a pending batch', () => {
    const code = 'const value = 1;';
    const queueChange = function queueChange(arb) {
      const target = arb.ast.find(node => node.type === 'Literal');
      arb.replaceNode(target, {type: 'Literal', value: 2, raw: '2'});
      return arb;
    };
    const replaceArborist = function replaceArborist(arb) {
      return new Arborist(arb.script);
    };

    assert.throws(
      () => applyIteratively(code, [queueChange, replaceArborist], {mode: 'batch'}),
      /Use mode: 'sequential'/,
    );
  });
  it('Accepts a replacement Arborist before a batch has pending changes', () => {
    const code = 'const value = 1;';
    const replaceArborist = function replaceArborist() {
      const arb = new Arborist('const value = 2;', {compactScopes: true, retainTokens: false});
      const target = arb.ast.find(node => node.type === 'Literal');
      arb.replaceNode(target, {type: 'Literal', value: 3, raw: '3'});
      return arb;
    };

    assert.equal(applyIteratively(code, [replaceArborist], {mode: 'batch', maxIterations: 1}),
      'const value = 3;');
  });
  it('Stops batch iteration after invalid output leaves source unchanged', () => {
    let calls = 0;
    const invalidModifier = function invalidModifier(arb) {
      calls++;
      const target = arb.ast.find(node => node.type === 'Literal');
      arb.replaceNode(target, {type: 'DefinitelyInvalid'});
      return arb;
    };

    assert.equal(applyIteratively('const value = 1;', [invalidModifier], {mode: 'batch'}), 'const value = 1;');
    assert.equal(calls, 1);
  });
  it('Validates iterative options and honors a zero iteration limit', () => {
    let calls = 0;
    const modifier = function modifier(arb) {
      calls++;
      return arb;
    };

    assert.equal(applyIteratively('value;', [modifier], {maxIterations: 0}), 'value;');
    assert.equal(calls, 0);
    assert.throws(() => applyIteratively('value;', [modifier], {mode: 'parallel'}), /Unknown applyIteratively mode/);
    assert.throws(() => applyIteratively('value;', [modifier], -1), /non-negative safe integer/);
  });
  it('Stops self-reproducing batches at the iteration limit', () => {
    let calls = 0;
    const increment = function increment(arb) {
      calls++;
      const target = arb.ast.find(node => node.type === 'Literal');
      const value = target.value + 1;
      arb.replaceNode(target, {type: 'Literal', value, raw: String(value)});
      return arb;
    };

    assert.equal(applyIteratively('let value = 0;', [increment], {mode: 'batch', maxIterations: 3}),
      'let value = 3;');
    assert.equal(calls, 3);
  });
  it('Seeds the iteration counter from currentIteration', () => {
    const originalLogFunc = logger.logFunc;
    const originalLogLevel = logger.currentLogLevel;
    const increment = function increment(arb) {
      const target = arb.ast.find(node => node.type === 'Literal');
      const value = target.value + 1;
      arb.replaceNode(target, {type: 'Literal', value, raw: String(value)});
      return arb;
    };
    const iterationNumbers = messages => messages
      .filter(message => typeof message === 'string' && message.includes('Iteration #'))
      .map(message => Number(message.match(/Iteration #(\d+)/)[1]));

    try {
      const defaultLogs = [];
      logger.setLogFunc((...args) => defaultLogs.push(...args));
      logger.setLogLevelLog();
      applyIteratively('let value = 0;', [increment], {maxIterations: 1});
      assert.deepEqual(iterationNumbers(defaultLogs), [1]);

      const zeroLogs = [];
      logger.setLogFunc((...args) => zeroLogs.push(...args));
      applyIteratively('let value = 0;', [increment], {currentIteration: 0, maxIterations: 1});
      assert.deepEqual(iterationNumbers(zeroLogs), [1]);

      let calls = 0;
      const countingIncrement = function countingIncrement(arb) {
        calls++;
        return increment(arb);
      };
      const continuedLogs = [];
      logger.setLogFunc((...args) => continuedLogs.push(...args));
      assert.equal(applyIteratively('let value = 0;', [countingIncrement], {
        currentIteration: 7,
        maxIterations: 10,
      }), 'let value = 3;');
      assert.equal(calls, 3);
      assert.deepEqual(iterationNumbers(continuedLogs), [8, 9, 10]);

      calls = 0;
      assert.equal(applyIteratively('let value = 0;', [countingIncrement], {
        currentIteration: 10,
        maxIterations: 10,
      }), 'let value = 0;');
      assert.equal(calls, 0);

      assert.throws(
        () => applyIteratively('value;', [increment], {currentIteration: -1}),
        /currentIteration must be a non-negative safe integer/,
      );
      assert.throws(
        () => applyIteratively('value;', [increment], {currentIteration: 1.5}),
        /currentIteration must be a non-negative safe integer/,
      );
    } finally {
      logger.setLogFunc(originalLogFunc);
      logger.setLogLevel(originalLogLevel);
    }
  });
  it('Stops a modifier at maxMarkedNodes and applies the queued marks', () => {
    const replaceSmall = function replaceSmall(arb) {
      for (const n of arb.ast[0].typeMap.Literal) {
        if (n.value < 10) arb.replaceNode(n, {type: 'Literal', value: n.value * 10, raw: String(n.value * 10)});
      }
      return arb;
    };
    replaceSmall.maxMarkedNodes = 1;

    assert.equal(
      applyIteratively('const values = [1, 2, 3];', [replaceSmall], {maxIterations: 1}),
      'const values = [\n  10,\n  2,\n  3\n];',
    );
    assert.equal(
      applyIteratively('const values = [1, 2, 3];', [replaceSmall], {maxIterations: 3}),
      'const values = [\n  10,\n  20,\n  30\n];',
    );
    assert.equal(
      applyIteratively('const values = [1, 2, 3];', [replaceSmall], {
        mode: 'batch',
        maxIterations: 1,
      }),
      'const values = [\n  10,\n  2,\n  3\n];',
    );

    const uncapped = function uncapped(arb) {
      return replaceSmall(arb);
    };
    assert.equal(
      applyIteratively('const values = [1, 2, 3];', [uncapped], {maxIterations: 1}),
      'const values = [\n  10,\n  20,\n  30\n];',
    );

    const optionCapped = function optionCapped(arb) {
      return replaceSmall(arb);
    };
    assert.equal(
      applyIteratively('const values = [1, 2, 3];', [optionCapped], {
        maxMarkedNodes: 1,
        maxIterations: 1,
      }),
      'const values = [\n  10,\n  2,\n  3\n];',
    );

    const override = function override(arb) {
      return replaceSmall(arb);
    };
    override.maxMarkedNodes = 2;
    assert.equal(
      applyIteratively('const values = [1, 2, 3];', [override], {
        maxMarkedNodes: 1,
        maxIterations: 1,
      }),
      'const values = [\n  10,\n  20,\n  3\n];',
    );

    const timed = function timed(arb) {
      return replaceSmall(arb);
    };
    timed.maxRunTimeMs = 1;
    assert.equal(
      applyIteratively('const values = [1, 2, 3];', [timed], {maxIterations: 1}),
      'const values = [\n  10,\n  20,\n  30\n];',
    );

    assert.throws(
      () => applyIteratively('value;', [replaceSmall], {maxMarkedNodes: -1}),
      /maxMarkedNodes must be a positive safe integer/,
    );
    assert.throws(
      () => applyIteratively('value;', [replaceSmall], {maxMarkedNodes: 0}),
      /maxMarkedNodes must be a positive safe integer/,
    );
    assert.throws(
      () => applyIteratively('value;', [replaceSmall], {maxMarkedNodes: 1.5}),
      /maxMarkedNodes must be a positive safe integer/,
    );
    const invalidFn = function invalidFn(arb) {
      return arb;
    };
    invalidFn.maxMarkedNodes = -1;
    assert.throws(
      () => applyIteratively('value;', [invalidFn]),
      /maxMarkedNodes must be a positive safe integer/,
    );
  });
  it('applyIterativelyAsync honors maxMarkedNodes and worker timeouts', async () => {
    const replaceSmall = function replaceSmall(arb) {
      for (const n of arb.ast[0].typeMap.Literal) {
        if (n.value < 10) arb.replaceNode(n, {type: 'Literal', value: n.value * 10, raw: String(n.value * 10)});
      }
      return arb;
    };
    replaceSmall.maxMarkedNodes = 1;
    assert.equal(
      await applyIterativelyAsync('const values = [1, 2, 3];', [replaceSmall], {maxIterations: 1}),
      'const values = [\n  10,\n  2,\n  3\n];',
    );

    const optionCapped = function optionCapped(arb) {
      return replaceSmall(arb);
    };
    assert.equal(
      await applyIterativelyAsync('const values = [1, 2, 3];', [optionCapped], {
        maxMarkedNodes: 1,
        maxIterations: 1,
      }),
      'const values = [\n  10,\n  2,\n  3\n];',
    );

    const markThenSpin = function markThenSpin(arb) {
      const first = arb.ast.find(node => node.type === 'Literal' && node.value === 1);
      if (first) arb.replaceNode(first, {type: 'Literal', value: 9, raw: '9'});
      const stop = Date.now() + 400;
      while (Date.now() < stop) { /* hold the worker until terminate() */ }
      const second = arb.ast.find(node => node.type === 'Literal' && node.value === 2);
      if (second) arb.replaceNode(second, {type: 'Literal', value: 8, raw: '8'});
      return arb;
    };
    markThenSpin.maxRunTimeMs = 250;
    assert.equal(
      await applyIterativelyAsync('const a = 1, b = 2;', [markThenSpin], {maxIterations: 1}),
      'const a = 9, b = 2;',
    );

    const bothLimits = function bothLimits(arb) {
      for (const n of arb.ast[0].typeMap.Literal) {
        if (n.value < 10) arb.replaceNode(n, {type: 'Literal', value: n.value * 10, raw: String(n.value * 10)});
      }
      return arb;
    };
    bothLimits.maxRunTimeMs = 5000;
    bothLimits.maxMarkedNodes = 1;
    assert.equal(
      await applyIterativelyAsync('const values = [1, 2, 3];', [bothLimits], {maxIterations: 1}),
      'const values = [\n  10,\n  2,\n  3\n];',
    );

    const invalidTime = function invalidTime(arb) {
      return arb;
    };
    invalidTime.maxRunTimeMs = 0;
    await assert.rejects(
      () => applyIterativelyAsync('value;', [invalidTime]),
      /maxRunTimeMs must be a positive safe integer/,
    );
  });
});
describe('Utils tests: logger', () => {
  it('Verify logger sets the log level to DEBUG properly', () => {
    const expectedLogLevel = logger.logLevels.DEBUG;
    logger.setLogLevelDebug();
    assert.equal(logger.currentLogLevel, expectedLogLevel, 'The log level DEBUG was not set properly');
  });
  it('Verify logger sets the log level to NONE properly', () => {
    const expectedLogLevel = logger.logLevels.NONE;
    logger.setLogLevelNone();
    assert.equal(logger.currentLogLevel, expectedLogLevel, 'The log level NONE was not set properly');
  });
  it('Verify logger sets the log level to LOG properly', () => {
    const expectedLogLevel = logger.logLevels.LOG;
    logger.setLogLevelLog();
    assert.equal(logger.currentLogLevel, expectedLogLevel, 'The log level LOG was not set properly');
  });
  it('Verify logger sets the log level to ERROR properly', () => {
    const expectedLogLevel = logger.logLevels.ERROR;
    logger.setLogLevelError();
    assert.equal(logger.currentLogLevel, expectedLogLevel, 'The log level ERROR was not set properly');
  });
  it('Verify logger sets the log function properly', () => {
    const expectedLogFunc = () => 'test';
    logger.setLogFunc(expectedLogFunc);
    assert.equal(logger.logFunc, expectedLogFunc, 'The log function was not set properly');
  });
  it('Verify logger forwards multiple arguments unchanged to the configured log function', () => {
    const originalLogFunc = logger.logFunc;
    const originalLogLevel = logger.currentLogLevel;
    let receivedArgs = null;
    logger.setLogFunc((...args) => {
      receivedArgs = args;
    });
    logger.setLogLevelDebug();
    logger.debug('%s %d', 'value', 7);
    assert.deepEqual(receivedArgs, ['%s %d', 'value', 7], 'Logger did not forward arguments unchanged');
    logger.setLogFunc(originalLogFunc);
    logger.setLogLevel(originalLogLevel);
  });
  it('Verify logger throws an error when setting an unknown log level', () => {
    assert.throws(() => logger.setLogLevel(0), Error, 'An error was not thrown when setting an unknown log level');
  });
  it('Verify logger suppresses lower-priority logs', () => {
    const originalLogFunc = logger.logFunc;
    const originalLogLevel = logger.currentLogLevel;
    let callCount = 0;
    logger.setLogFunc(() => {
      callCount += 1;
    });
    logger.setLogLevelError();

    logger.debug('hidden debug');
    logger.log('hidden log');
    logger.error('visible error');

    assert.equal(callCount, 1, 'Logger did not suppress lower-priority calls');
    logger.setLogFunc(originalLogFunc);
    logger.setLogLevel(originalLogLevel);
  });
});
