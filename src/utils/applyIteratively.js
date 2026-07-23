import {Arborist} from '../arborist.js';
import {logger} from './logger.js';
import {createHash} from 'node:crypto';

/**
 * Create a stable digest used to recognize an unchanged Arborist root.
 *
 * @example
 * generateHash('const value = 1;') === generateHash('const value = 1;'); // true
 *
 * @param {string} str Source text to hash.
 * @return {string} Lowercase SHA-256 digest.
 */
const generateHash = str => createHash('sha256').update(str).digest('hex');

/**
 * Apply modifiers repeatedly until one complete pass leaves the source unchanged.
 *
 * Each modifier receives the latest Arborist and must return an Arborist. It
 * may queue changes on the existing instance or return a replacement instance.
 * Queued changes are applied before the next modifier runs.
 *
 * @example
 * const replaceOne = arborist => {
 *   const literal = arborist.ast[0].typeMap.Literal.find(node => node.value === 1);
 *   if (literal) arborist.replaceNode(literal, {type: 'Literal', value: 2});
 *   return arborist;
 * };
 * applyIteratively('const value = 1;', [replaceOne]); // 'const value = 2;'
 *
 * @example
 * // Self-reproducing transformations are bounded explicitly.
 * applyIteratively(source, [modifier], 10);
 *
 * @param {string} script The target script to run the functions on.
 * @param {Array<(arborist: Arborist) => Arborist>} funcs Ordered modifier functions.
 * @param {number} [maxIterations=500] Maximum number of complete passes.
 * @return {string} The possibly modified script.
 */
function applyIteratively(script, funcs, maxIterations = 500) {
  let scriptSnapshot = '';
  let currentIteration = 0;
  let changesCounter = 0;
  let iterationsCounter = 0;
  try {
    let scriptHash = generateHash(script);
    let arborist = new Arborist(script);
    while (arborist.ast?.length && scriptSnapshot !== script && currentIteration < maxIterations) {
      const iterationStartTime = Date.now();
      scriptSnapshot = script;

      // The marker distinguishes mutation of this Arborist from a modifier
      // returning a newly constructed Arborist for different source.
      arborist.ast[0].scriptHash = scriptHash;
      for (let i = 0; i <  funcs.length; i++) {
        const func = funcs[i];
        const funcStartTime = Date.now();
        try {
          logger.debug(`\t[!] Running ${func.name}...`);
          arborist = func(arborist);
          if (!arborist.ast?.length) break;
          // A new Arborist lacks the marker, so treat the replacement itself
          // as a change even if it has no queued node mutations.
          const numberOfNewChanges = arborist.getNumberOfChanges() + +!arborist.ast[0].scriptHash;
          if (numberOfNewChanges) {
            changesCounter += numberOfNewChanges;
            logger.log(`\t[+] ${func.name} applying ${numberOfNewChanges} new changes!`);
            arborist.applyChanges();
            script = arborist.script;
            scriptHash = generateHash(script);
            arborist.ast[0].scriptHash = scriptHash;
          }
        } catch (e) {
          logger.error(`[-] Error in ${func.name} (iteration #${iterationsCounter}): ${e}\n${e.stack}`);
        } finally {
          logger.debug(`\t\t[!] Running ${func.name} completed in ` +
              `${((Date.now() - funcStartTime) / 1000).toFixed(3)} seconds`);
        }
      }
      ++currentIteration;
      ++iterationsCounter;
      logger.log(`[+] ==> Iteartion #${iterationsCounter} completed in ${(Date.now() - iterationStartTime) / 1000} seconds` +
          ` with ${changesCounter ? changesCounter : 'no'} changes (${arborist.ast?.length || '???'} nodes)`);
      changesCounter =  0;
    }
    if (changesCounter) script = arborist.script;
  } catch (e) {
    logger.error(`[-] Error on iteration #${iterationsCounter}: ${e}\n${e.stack}`);
  }
  return script;
}

export {applyIteratively};
