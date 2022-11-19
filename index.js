const fs = require('fs').promises;
const path = require('path');
const { pathToFileURL } = require('url');
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

async function transformWithBabel(filename, data, pluginOptions, plugins = []) {
  const forceAsyncTransformation =
    !/[\\/][_f]?esm2015[\\/]/.test(filename) && /async\s+function\s*\*/.test(data);
  const shouldLink = await requiresLinking(filename, data);
  const useInputSourcemap =
    pluginOptions.sourcemap &&
    (!!pluginOptions.thirdPartySourcemaps || !/[\\/]node_modules[\\/]/.test(filename));

  const angularPackage = /[\\/]node_modules[\\/]@angular[\\/]/.test(filename);

  const linkerPluginCreator = shouldLink
    ? (await import('@angular/compiler-cli/linker/babel')).createEs2015LinkerPlugin
    : undefined;

  const result = await transformAsync(data, {
    filename,
    inputSourceMap: useInputSourcemap ? undefined : false,
    sourceMaps: pluginOptions.sourcemap ? 'inline' : false,
    compact: false,
    configFile: false,
    babelrc: false,
    browserslistConfigFile: false,
    plugins,
    presets: [
      [
        angularApplicationPreset,
        {
          angularLinker: {
            shouldLink,
            jitMode: false,
            linkerPluginCreator,
          },
          forceAsyncTransformation,
          optimize: pluginOptions.advancedOptimizations && {
            looseEnums: angularPackage,
            pureTopLevel: angularPackage,
          },
        },
      ],
    ],
  });

  return result;
}

function findAffectedFiles(
  builder,
  { ignoreForDiagnostics, ignoreForEmit, incrementalCompilation }
) {
  const affectedFiles = new Set();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = builder.getSemanticDiagnosticsOfNextAffectedFile(undefined, sourceFile => {
      // If the affected file is a TTC shim, add the shim's original source file.
      // This ensures that changes that affect TTC are typechecked even when the changes
      // are otherwise unrelated from a TS perspective and do not result in Ivy codegen changes.
      // For example, changing @Input property types of a directive used in another component's
      // template.
      // A TTC shim is a file that has been ignored for diagnostics and has a filename ending in `.ngtypecheck.ts`.
      if (ignoreForDiagnostics.has(sourceFile) && sourceFile.fileName.endsWith('.ngtypecheck.ts')) {
        // This file name conversion relies on internal compiler logic and should be converted
        // to an official method when available. 15 is length of `.ngtypecheck.ts`
        const originalFilename = sourceFile.fileName.slice(0, -15) + '.ts';
        const originalSourceFile = builder.getSourceFile(originalFilename);
        if (originalSourceFile) {
          affectedFiles.add(originalSourceFile);
        }

        return true;
      }

      return false;
    });

    if (!result) {
      break;
    }

    affectedFiles.add(result.affected);
  }

  // A file is also affected if the Angular compiler requires it to be emitted
  for (const sourceFile of builder.getSourceFiles()) {
    if (ignoreForEmit.has(sourceFile) || incrementalCompilation.safeToSkipEmit(sourceFile)) {
      continue;
    }

    affectedFiles.add(sourceFile);
  }

  return affectedFiles;
}

const USING_WINDOWS = require('os').platform() === 'win32';
const WINDOWS_SEP_REGEXP = new RegExp(`\\${path.win32.sep}`, 'g');

class SourceFileCache extends Map {
  modifiedFiles = new Set();
  babelFileCache = new Map();
  typeScriptFileCache = new Map();

  invalidate(files) {
    this.modifiedFiles.clear();
    for (let file of files) {
      this.babelFileCache.delete(file);
      this.typeScriptFileCache.delete(pathToFileURL(file).href);

      // Normalize separators to allow matching TypeScript Host paths
      if (USING_WINDOWS) {
        file = file.replace(WINDOWS_SEP_REGEXP, path.posix.sep);
      }

      this.delete(file);
      this.modifiedFiles.add(file);
    }
  }
}

module.exports = function angular(pluginOptions) {
  let fileEmitter, resolveModule, previousAngularProgram, previousBuilder;
  const ref_file_ids = new Map();
  const babelDataCache = new Map();
  const diagnosticCache = new WeakMap();
  const resourceFileMap = new Map();
  const sourceFileCache = new SourceFileCache();

  return {
    name: 'angular',
    async buildStart() {
      const { NgtscProgram, OptimizeFor, readConfiguration, formatDiagnostics } = await import(
        '@angular/compiler-cli'
      );
      const {
        augmentProgramWithVersioning,
        augmentHostWithReplacements,
        augmentHostWithCaching,
      } = require('@ngtools/webpack/src/ivy/host');
      const {
        mergeTransformers,
        createAotTransformers,
      } = require('@ngtools/webpack/src/ivy/transformation');

      const {
        options: compilerOptions,
        rootNames,
        errors: configurationDiagnostics,
      } = readConfiguration(pluginOptions.tsconfig, {
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
        process.cwd(),
        async ({ url, absolutePath }) => {
          const name = path.basename(url);
          const source = await fs.readFile(absolutePath);

          const ref_id = this.emitFile({
            type: 'asset',
            name,
            source,
          });
          this.addWatchFile(absolutePath);
          ref_file_ids.set(ref_id, {
            type: 'asset',
            name,
            source,
          });

          return `%%${ref_id}%%`;
        },
        []
      );

      host.readResource = function (fileName) {
        return this.readFile(fileName) ?? '';
      };
      host.transformResource = async (data, context) => {
        if (context.type !== 'style') {
          return null;
        }

        const file = context.resourceFile ?? context.containingFile;
        const content = await processor.process({
          filePath: file,
          content: data,
        });

        if (context.resourceFile) {
          const files = resourceFileMap.get(context.containingFile) ?? new Set();

          files.add(context.resourceFile);

          resourceFileMap.set(context.containingFile, files);
        }

        return { content };
      };

      // Allow the AOT compiler to request the set of changed templates and styles
      host.getModifiedResourceFiles = () => sourceFileCache.modifiedFiles;

      // Augment TypeScript Host for file replacements option
      if (pluginOptions.fileReplacements) {
        augmentHostWithReplacements(host, pluginOptions.fileReplacements);
      }

      // Augment TypeScript Host with source file caching if provided
      if (sourceFileCache) {
        augmentHostWithCaching(host, sourceFileCache);
      }

      const angularProgram = new NgtscProgram(
        rootNames,
        compilerOptions,
        host,
        previousAngularProgram
      );
      previousAngularProgram = angularProgram;
      const angularCompiler = angularProgram.compiler;
      const typeScriptProgram = angularProgram.getTsProgram();

      augmentProgramWithVersioning(typeScriptProgram);

      const builder = ts.createEmitAndSemanticDiagnosticsBuilderProgram(
        typeScriptProgram,
        host,
        previousBuilder
      );
      previousBuilder = builder;

      await angularCompiler.analyzeAsync();

      const affectedFiles = findAffectedFiles(builder, angularCompiler);

      if (sourceFileCache) {
        for (const affected of affectedFiles) {
          sourceFileCache.typeScriptFileCache.delete(pathToFileURL(affected.fileName).href);
        }
      }

      // Copied from https://github.com/angular/angular-cli/blob/main/packages/angular_devkit/build_angular/src/builders/browser-esbuild/compiler-plugin.ts#L237
      function* collectDiagnostics() {
        yield* configurationDiagnostics;
        yield* angularCompiler.getOptionDiagnostics();
        yield* builder.getOptionsDiagnostics();
        yield* builder.getGlobalDiagnostics();

        const optimizeFor =
          affectedFiles.size > 1 ? OptimizeFor.WholeProgram : OptimizeFor.SingleFile;

        for (const sourceFile of builder.getSourceFiles()) {
          if (angularCompiler.ignoreForDiagnostics.has(sourceFile)) {
            continue;
          }

          yield* builder.getSyntacticDiagnostics(sourceFile);
          yield* builder.getSemanticDiagnostics(sourceFile);

          // Declaration files cannot have template diagnostics
          if (sourceFile.isDeclarationFile) {
            continue;
          }

          // Only request Angular template diagnostics for affected files to avoid
          // overhead of template diagnostics for unchanged files.
          if (affectedFiles.has(sourceFile)) {
            const angularDiagnostics = angularCompiler.getDiagnosticsForFile(
              sourceFile,
              optimizeFor
            );

            diagnosticCache.set(sourceFile, angularDiagnostics);

            yield* angularDiagnostics;
          } else {
            const angularDiagnostics = diagnosticCache.get(sourceFile);
            if (angularDiagnostics) {
              yield* angularDiagnostics;
            }
          }
        }
      }

      const errors = [];

      for (const diagnostic of collectDiagnostics()) {
        const message = formatDiagnostics([diagnostic]);

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
        sourceFile => angularCompiler.incrementalCompilation.recordSuccessfulEmit(sourceFile)
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

      for (const [, asset] of ref_file_ids) {
        this.emitFile(asset);
      }
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
    async transform(code, id) {
      if (/\.[cm]?tsx?$/.test(id)) {
        const request = pluginOptions.fileReplacements?.[id] ?? id;

        // The filename is currently used as a cache key. Since the cache is memory only,
        // the options cannot change and do not need to be represented in the key. If the
        // cache is later stored to disk, then the options that affect transform output
        // would need to be added to the key as well as a check for any change of content.
        let codeAndMap = sourceFileCache?.typeScriptFileCache.get(pathToFileURL(request).href);

        if (codeAndMap === undefined) {
          const typescriptResult = await fileEmitter(id);

          if (!typescriptResult) {
            throw new Error(id + ' is not in typescript compilation');
          }

          const data = typescriptResult.content ?? '';
          // The pre-transformed data is used as a cache key. Since the cache is memory only,
          // the options cannot change and do not need to be represented in the key. If the
          // cache is later stored to disk, then the options that affect transform output
          // would need to be added to the key as well.
          codeAndMap = babelDataCache.get(data);
          if (codeAndMap === undefined) {
            codeAndMap = await transformWithBabel(request, data, pluginOptions, [
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
            ]);

            babelDataCache.set(data, codeAndMap);
          }

          sourceFileCache?.typeScriptFileCache.set(pathToFileURL(request).href, codeAndMap);
        }

        const resourceFiles = resourceFileMap.get(request) ?? new Set();

        for (const resourceFile of resourceFiles) {
          this.addWatchFile(resourceFile);
        }

        return codeAndMap;
      } else if (/\.[cm]?js$/.test(id)) {
        let codeAndMap = sourceFileCache?.babelFileCache.get(id);

        if (codeAndMap === undefined) {
          codeAndMap = await transformWithBabel(id, code, pluginOptions);

          sourceFileCache?.babelFileCache.set(id, codeAndMap);
        }

        return codeAndMap;
      }

      return null;
    },
    watchChange(id, { event }) {
      sourceFileCache.invalidate([id]);

      if (event === 'delete') {
        for (const [key, files] of resourceFileMap) {
          if (files.has(id)) {
            files.delete(id);

            resourceFileMap.set(key, files);
          }
        }
      }
    },
  };
};
