# rollup-plugin-angular-angular
Rollup plugin for angular AOT compilation

Inspired by [Angular CLI esbuild plugin](https://github.com/angular/angular-cli/blob/main/packages/angular_devkit/build_angular/src/builders/browser-esbuild/compiler-plugin.ts)

Currently this project is working in progress. It doesn't support JIT compilation.

### Example

You can try example by running following commands

```bash
yarn rollup -c example/rollup.config.js
node example/serve.js
```

and open `http://localhost:3000` in browser.
