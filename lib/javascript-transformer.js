/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

const Piscina = require('piscina');

module.exports = class JavaScriptTransformer {
  #workerPool;
  options;

  constructor(options, maxThreads) {
    this.options = options;
    this.#workerPool = new Piscina({
      filename: require.resolve('./javascript-transformer-worker'),
      maxThreads,
    });
  }

  async transformData(filename, data, skipLinker, needResourceProcess) {
    // Perform a quick test to determine if the data needs any transformations.
    // This allows directly returning the data without the worker communication overhead.
    let forceAsyncTransformation;
    if (skipLinker && !this.options.advancedOptimizations) {
      // If the linker is being skipped and no optimizations are needed, only async transformation is left.
      // This checks for async generator functions. All other async transformation is handled by esbuild.
      forceAsyncTransformation = data.includes('async') && /async\s+function\s*\*/.test(data);
    }

    return this.#workerPool.run({
      filename,
      data,
      // Send the async check result if present to avoid rechecking in the worker
      forceAsyncTransformation,
      skipLinker,
      needResourceProcess,
      ...this.options,
    });
  }

  close() {
    return this.#workerPool.destroy();
  }
};
