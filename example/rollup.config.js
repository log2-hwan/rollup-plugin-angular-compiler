const { rm } = require('fs/promises');
const { nodeResolve } = require('@rollup/plugin-node-resolve');
const { default: html, makeHtmlAttributes } = require('@rollup/plugin-html');
const terser = require('@rollup/plugin-terser').default;
const angular = require('../lib/index');

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
      async buildStart() {
        try {
          await rm('build', { recursive: true });
        } catch {}
      },
    },
    angular({
      advancedOptimizations: true,
      sourcemap: true,
      tsconfig: './example/tsconfig.json',
    }),
    nodeResolve({
      mainFields: ['es2022', 'module', 'browser', 'main'],
      exportConditions: ['es2022', 'module', 'main'],
    }),
    terser({
      ecma: 6,
      toplevel: false,
      mangle: true,
      compress: {
        pure_funcs: ['forwardRef'],
        pure_getters: true,
        passes: 3,
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
        <title>Rollup Angular Compiler Plugin Example</title>
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
