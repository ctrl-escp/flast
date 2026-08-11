const logLevels = {
  DEBUG: 1,
  LOG: 2,
  ERROR: 3,
  NONE: 9e10,
};

/**
 * Create a log method whose threshold is evaluated at call time.
 *
 * @example
 * const debug = createLoggerForLevel(logLevels.DEBUG);
 * logger.currentLogLevel = logLevels.ERROR;
 * debug('hidden'); // Does not call logger.logFunc.
 *
 * @param {number} logLevel Severity assigned to the returned method.
 * @returns {(...args: unknown[]) => void|undefined} Threshold-aware log method.
 */
function createLoggerForLevel(logLevel) {
  if (!Object.values(logLevels).includes(logLevel)) throw new Error(`Unknown log level ${logLevel}.`);
  return (...args) => logLevel >= logger.currentLogLevel ? logger.logFunc(...args) : undefined;
}

/**
 * Shared configurable logger used by parsing and iterative transforms.
 *
 * Logging is disabled by default. Setting a level enables that severity and
 * every more severe level.
 *
 * @example
 * logger.setLogLevelLog();
 * logger.debug('hidden');
 * logger.log('visible');
 * logger.error('also visible');
 *
 * @example
 * const messages = [];
 * logger.setLogFunc((...args) => messages.push(args));
 * logger.setLogLevelDebug();
 */
const logger = {
  logLevels,
  logFunc: console.log,
  debug: createLoggerForLevel(logLevels.DEBUG),
  log: createLoggerForLevel(logLevels.LOG),
  error: createLoggerForLevel(logLevels.ERROR),
  currentLogLevel: logLevels.NONE,

  /**
   * Set the minimum severity that will be emitted.
   *
   * @example
   * logger.setLogLevel(logger.logLevels.ERROR);
   *
   * @param {number} newLogLevel One of the values in logger.logLevels.
   * @return {void}
   */
  setLogLevel(newLogLevel) {
    if (!Object.values(this.logLevels).includes(newLogLevel)) throw new Error(`Unknown log level ${newLogLevel}.`);
    this.currentLogLevel = newLogLevel;
  },

  /**
   * Disable all logger output.
   * @return {void}
   */
  setLogLevelNone() {this.setLogLevel(this.logLevels.NONE);},

  /**
   * Emit debug, log, and error messages.
   * @return {void}
   */
  setLogLevelDebug() {this.setLogLevel(this.logLevels.DEBUG);},

  /**
   * Emit log and error messages while suppressing debug output.
   * @return {void}
   */
  setLogLevelLog() {this.setLogLevel(this.logLevels.LOG);},

  /**
   * Emit only error messages.
   * @return {void}
   */
  setLogLevelError() {this.setLogLevel(this.logLevels.ERROR);},

  /**
   * Replace the destination used by every enabled log method.
   *
   * @example
   * logger.setLogFunc((...args) => collectedMessages.push(args));
   *
   * @param {(...args: unknown[]) => void} newLogFunc Log sink such as console.log.
   * @return {void}
   */
  setLogFunc(newLogFunc) {
    this.logFunc = newLogFunc;
  },
};

export {logger};
