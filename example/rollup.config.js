const { rm } = require('fs/promises');
const { nodeResolve } = require('@rollup/plugin-node-resolve');
const { default: html, makeHtmlAttributes } = require('@rollup/plugin-html');
const { terser } = require('rollup-plugin-terser');
const angular = require('../index');

module.exports = {
  input: './example/src/main.ts',
  output: {
    format: 'es',
    dir: 'build',
    generatedCode: 'es2015',
    entryFileNames: '[name]-[hash].js',
  },
  treeshake: {
    propertyReadSideEffects: false,
    unknownGlobalSideEffects: false,
    tryCatchDeoptimization: false,
  },
  preserveEntrySignatures: false,
  plugins: [
    {
      async buildStart(options) {
        await rm('build', { recursive: true });
      },
    },
    angular({
      advancedOptimizations: true,
      sourcemap: true,
      tsconfig: './example/tsconfig.json',
    }),
    nodeResolve({
      mainFields: ['es2015', 'module', 'browser', 'main'],
      exportConditions: ['es2020', 'es2015', 'module', 'main'],
    }),
    terser({
      ecma: 6,
      toplevel: false,
      mangle: {
        safari10: true,
      },
      compress: {
        arrows: true,
        module: true,
        hoist_funs: true,
        hoist_props: true,
        warnings: false,
        conditionals: true,
        unused: true,
        comparisons: true,
        sequences: true,
        dead_code: true,
        evaluate: true,
        if_return: true,
        inline: true,
        join_vars: true,
        negate_iife: false,
        collapse_vars: true,
        reduce_vars: true,
        reduce_funcs: false,
        side_effects: true,
        pure_getters: true,
        passes: 4,
        global_defs: {
          ngDevMode: false,
          ngI18nClosureMode: false,
          ngJitMode: false,
        },
      },
      output: {
        comments: false,
      },
    }),
    html({
      template: ({ attributes, files }) => {
        return `<!DOCTYPE html>
<html${makeHtmlAttributes(attributes.html)}>
    <head>
        <base href="/">
        <title>Rollup Angular Plugin Example</title>
    </head>
    <body>
        <main-app></main-app>
        ${files.js
          .filter(file => file.isEntry)
          .map(file => `<script type="module" src="${file.fileName}"></script>`)
          .join('\n')}
    </body>
</html>`;
      },
    }),
  ],
};
