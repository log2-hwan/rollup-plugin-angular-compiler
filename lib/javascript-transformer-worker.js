/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

const { transformAsync } = require('@babel/core');
const babelTypes = require('@babel/types');
const angularApplicationPreset =
  require('@angular-devkit/build-angular/src/babel/presets/application').default;
const { requiresLinking } = require('@angular-devkit/build-angular/src/babel/webpack-loader');

module.exports = async function transformJavaScript(request) {
  const transformedData = await transformWithBabel(request);

  return transformedData;
};

let linkerPluginCreator;

function getRollupResourceBabelPlugin() {
  return [
    () => ({
      visitor: {
        ArrayExpression: path => {
          if (
            path.node.type === 'ArrayExpression' &&
            path.parentPath.node.type === 'ObjectProperty' &&
            path.parentPath.node.key.name === 'styles'
          ) {
            path.node.elements = path.node.elements.map(({ value }) => {
              const tokens = value.split(/\%\%(\S+)\%\%/);
              const referenceIds = tokens.filter((_, i) => i % 2 === 1);

              return babelTypes.templateLiteral(
                tokens
                  .filter((_, i) => i % 2 === 0)
                  .map((token, i) =>
                    babelTypes.templateElement({ raw: token }, i === path.node.elements.length - 1)
                  ),
                referenceIds.map(referenceId =>
                  babelTypes.memberExpression(
                    babelTypes.metaProperty(
                      babelTypes.identifier('import'),
                      babelTypes.identifier('meta')
                    ),
                    babelTypes.identifier(`ROLLUP_FILE_URL_${referenceId}`)
                  )
                )
              );
            });
          }
        },
      },
    }),
  ];
}

async function transformWithBabel({ filename, data, ...options }) {
  const forceAsyncTransformation =
    options.forceAsyncTransformation ??
    (!/[\\/][_f]?esm2015[\\/]/.test(filename) && /async\s+function\s*\*/.test(data));
  const shouldLink = !options.skipLinker && (await requiresLinking(filename, data));
  const useInputSourcemap =
    options.sourcemap &&
    (!!options.thirdPartySourcemaps || !/[\\/]node_modules[\\/]/.test(filename));

  // If no additional transformations are needed, return the data directly
  if (!forceAsyncTransformation && !options.advancedOptimizations && !shouldLink) {
    // Strip sourcemaps if they should not be used
    return useInputSourcemap ? data : data.replace(/^\/\/# sourceMappingURL=[^\r\n]*/gm, '');
  }

  const angularPackage = /[\\/]node_modules[\\/]@angular[\\/]/.test(filename);

  // Lazy load the linker plugin only when linking is required
  if (shouldLink) {
    linkerPluginCreator ??= (await import('@angular/compiler-cli/linker/babel'))
      .createEs2015LinkerPlugin;
  }

  const result = await transformAsync(data, {
    filename,
    inputSourceMap: useInputSourcemap ? undefined : false,
    sourceMaps: options.sourcemap ? 'inline' : false,
    compact: false,
    configFile: false,
    babelrc: false,
    browserslistConfigFile: false,
    plugins: options.needResourceProcess ? [getRollupResourceBabelPlugin()] : [],
    presets: [
      [
        angularApplicationPreset,
        {
          angularLinker: linkerPluginCreator && {
            shouldLink,
            jitMode: false,
            linkerPluginCreator,
          },
          forceAsyncTransformation,
          optimize: options.advancedOptimizations && {
            looseEnums: angularPackage,
            pureTopLevel: angularPackage,
          },
        },
      ],
    ],
  });

  return result?.code ?? data;
}
