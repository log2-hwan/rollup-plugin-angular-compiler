const fs = require('fs').promises;
const path = require('path');
const ts = require('typescript');
const { transformAsync } = require('@babel/core');
const babelTypes = require('@babel/types');
const angularApplicationPreset =
  require('@angular-devkit/build-angular/src/babel/presets/application').default;
const { StylesheetProcessor } = require('ng-packagr/lib/styles/stylesheet-processor');

let needsLinking;

// Copied from https://github.com/angular/angular-cli/blob/main/packages/angular_devkit/build_angular/src/babel/webpack-loader.ts#L42
async function requiresLinking(file_path, source) {
  if (/[\\/]@angular[\\/](?:compiler|core)|\.tsx?$/.test(file_path)) {
    return false;
  }

  if (!needsLinking) {
    const linkerModule = await import('@angular/compiler-cli/linker');
    needsLinking = linkerModule.needsLinking;
  }

  return needsLinking(file_path, source);
}

// Copied from https://github.com/angular/angular-cli/blob/main/packages/angular_devkit/build_angular/src/builders/browser-esbuild/compiler-plugin.ts#L388
function createFileEmitter(program, transformers = {}, onAfterEmit) {
  return async file => {
    const sourceFile = program.getSourceFile(file);
    if (!sourceFile) {
      return undefined;
    }

    let content;

    program.emit(
      sourceFile,
      (filename, data) => {
        if (/\.[cm]?js$/.test(filename)) {
          content = data;
        }
      },
      undefined /* cancellationToken */,
      undefined /* emitOnlyDtsFiles */,
      transformers
    );

    onAfterEmit?.(sourceFile);

    return { content, dependencies: [] };
  };
}

module.exports = function angular(pluginOptions) {
  let fileEmitter, resolveModule;
  const ref_file_ids = new Set();

  return {
    name: 'angular',
    async buildStart() {
      const compilerCli = await import('@angular/compiler-cli');
      const {
        createAotTransformers,
        mergeTransformers,
      } = require('@ngtools/webpack/src/ivy/transformation');

      const {
        options: compilerOptions,
        rootNames,
        errors: configurationDiagnostics,
      } = compilerCli.readConfiguration(pluginOptions.tsconfig, {
        enableIvy: true,
        noEmitOnError: false,
        suppressOutputPathCheck: true,
        outDir: undefined,
        inlineSources: pluginOptions.sourcemap,
        inlineSourceMap: pluginOptions.sourcemap,
        sourceMap: false,
        mapRoot: undefined,
        sourceRoot: undefined,
        declaration: false,
        declarationMap: false,
        allowEmptyCodegenFiles: false,
        annotationsAs: 'decorators',
        enableResourceInlining: false,
      });
      const host = ts.createIncrementalCompilerHost(compilerOptions);
      const processor = new StylesheetProcessor(
        process.cwd(),
        async ({ url, absolutePath }) => {
          const name = path.basename(url);
          const source = await fs.readFile(absolutePath);
          const ref_id = this.emitFile({
            type: 'asset',
            name,
            source,
          });

          this.addWatchFile(ref_id);
          ref_file_ids.add(ref_id);

          return `%%${ref_id}%%`;
        },
        []
      );

      host.readResource = function (fileName) {
        return this.readFile(fileName) ?? '';
      };
      host.transformResource = async function (data, context) {
        if (context.type !== 'style') {
          return null;
        }

        const file = context.resourceFile ?? context.containingFile;
        const contents = await processor.process({
          filePath: file,
          content: data,
        });

        return { content: contents };
      };

      const angularProgram = new compilerCli.NgtscProgram(rootNames, compilerOptions, host);
      const angularCompiler = angularProgram.compiler;
      const { ignoreForDiagnostics } = angularCompiler;
      const typeScriptProgram = angularProgram.getTsProgram();
      const builder = ts.createAbstractBuilder(typeScriptProgram, host);

      await angularCompiler.analyzeAsync();

      // Copied from https://github.com/angular/angular-cli/blob/main/packages/angular_devkit/build_angular/src/builders/browser-esbuild/compiler-plugin.ts#L237
      function* collectDiagnostics() {
        yield* configurationDiagnostics;
        yield* angularCompiler.getOptionDiagnostics();
        yield* builder.getOptionsDiagnostics();
        yield* builder.getGlobalDiagnostics();

        // Collect source file specific diagnostics
        const OptimizeFor = compilerCli.OptimizeFor;
        for (const sourceFile of builder.getSourceFiles()) {
          if (ignoreForDiagnostics.has(sourceFile)) {
            continue;
          }

          yield* builder.getSyntacticDiagnostics(sourceFile);
          yield* builder.getSemanticDiagnostics(sourceFile);

          const angularDiagnostics = angularCompiler.getDiagnosticsForFile(
            sourceFile,
            OptimizeFor.WholeProgram
          );
          yield* angularDiagnostics;
        }
      }

      const errors = [];

      for (const diagnostic of collectDiagnostics()) {
        const message = compilerCli.formatDiagnostics([diagnostic]);

        if (diagnostic.category === ts.DiagnosticCategory.Error) {
          errors.push(message);
        } else {
          this.warn(message);
        }
      }

      if (errors.length > 0) {
        this.warn(errors.join('\n'));

        throw new Error('Error while Angular compilation');
      }

      fileEmitter = createFileEmitter(
        builder,
        mergeTransformers(
          angularCompiler.prepareEmit().transformers,
          createAotTransformers(builder, {})
        ),
        () => []
      );

      const cache = ts.createModuleResolutionCache(
        process.cwd(),
        host.getCanonicalFileName,
        compilerOptions
      );

      resolveModule = (moduleName, containingFile) => {
        return ts.nodeModuleNameResolver(moduleName, containingFile, compilerOptions, host, cache)
          .resolvedModule;
      };
    },
    async resolveId(importee, importer) {
      if (!importer) {
        return null;
      }

      const resolved = resolveModule(importee, importer);

      if (resolved) {
        if (resolved.extension === '.d.ts') {
          return null;
        }

        return path.normalize(resolved.resolvedFileName);
      }

      return null;
    },
    resolveFileUrl({ relativePath, referenceId }) {
      if (ref_file_ids.has(referenceId)) {
        return `'${relativePath}'`;
      } else {
        return null;
      }
    },
    async load(id) {
      if (/\.[cm]?tsx?$/.test(id)) {
        const typescriptResult = await fileEmitter(id);

        if (!typescriptResult) {
          throw new Error(id + ' is not in typescript compilation');
        }

        const data = typescriptResult.content ?? '';
        const result = await transformAsync(data, {
          filename: id,
          inputSourceMap: pluginOptions.sourcemap ? undefined : false,
          sourceMaps: pluginOptions.sourcemap ? 'inline' : false,
          compact: false,
          configFile: false,
          babelrc: false,
          browserslistConfigFile: false,
          plugins: [
            [
              () => ({
                visitor: {
                  ArrayExpression: path => {
                    if (
                      path.node.type === 'ArrayExpression' &&
                      path.parentPath.node.type === 'ObjectProperty' &&
                      path.parentPath.node.key.name === 'styles'
                    ) {
                      path.node.elements = path.node.elements.map(({ value }, i) => {
                        const tokens = value.split(/\%\%(\S+)\%\%/);

                        return babelTypes.templateLiteral(
                          tokens
                            .filter((_, i) => i % 2 === 0)
                            .map((token, i) =>
                              babelTypes.templateElement(
                                { raw: token },
                                i === path.node.elements.length - 1
                              )
                            ),
                          tokens
                            .filter((_, i) => i % 2 === 1)
                            .map(matched_str =>
                              babelTypes.memberExpression(
                                babelTypes.metaProperty(
                                  babelTypes.identifier('import'),
                                  babelTypes.identifier('meta')
                                ),
                                babelTypes.identifier(`ROLLUP_FILE_URL_${matched_str}`)
                              )
                            )
                        );
                      });
                    }
                  },
                },
              }),
            ],
          ],
          presets: [
            [
              angularApplicationPreset,
              {
                forceAsyncTransformation: data.includes('async'),
                optimize: pluginOptions.advancedOptimizations && {},
              },
            ],
          ],
        });

        return { code: result.code, map: result.map };
      } else if (/\.[cm]?js$/.test(id)) {
        const angularPackage = /[\\/]node_modules[\\/]@angular[\\/]/.test(id);

        const linkerPluginCreator = (await import('@angular/compiler-cli/linker/babel'))
          .createEs2015LinkerPlugin;

        const code = await fs.readFile(id, 'UTF-8');
        const result = await transformAsync(code, {
          filename: id,
          inputSourceMap: pluginOptions.sourcemap ? undefined : false,
          sourceMaps: pluginOptions.sourcemap ? 'inline' : false,
          compact: false,
          configFile: false,
          babelrc: false,
          browserslistConfigFile: false,
          presets: [
            [
              angularApplicationPreset,
              {
                angularLinker: {
                  shouldLink: await requiresLinking(id, code),
                  jitMode: false,
                  linkerPluginCreator,
                },
                forceAsyncTransformation:
                  !/[\\/][_f]?esm2015[\\/]/.test(id) && code.includes('async'),
                optimize: pluginOptions.advancedOptimizations && {
                  looseEnums: angularPackage,
                  pureTopLevel: angularPackage,
                },
              },
            ],
          ],
        });

        return { code: result.code, map: result.map };
      }

      return null;
    },
  };
};
