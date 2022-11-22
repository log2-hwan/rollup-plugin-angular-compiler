const fs = require('fs').promises;
const path = require('path');
const { pathToFileURL } = require('url');
const ts = require('typescript');
const { transformAsync } = require('@babel/core');
const { StylesheetProcessor } = require('ng-packagr/lib/styles/stylesheet-processor');

const JavaScriptTransformer = require('./javascript-transformer');

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

module.exports = function angularCompiler(pluginOptions) {
  let fileEmitter, resolveModule, previousAngularProgram, previousBuilder;
  const fileReferenceIdMap = new Map();
  const babelDataCache = new Map();
  const diagnosticCache = new WeakMap();
  const sourceFileToStyleMap = new Map();
  const resourceFileToStyleMap = new Map();
  const sourceFileCache = new SourceFileCache();

  // Initialize a worker pool for JavaScript transformations
  const javascriptTransformer = new JavaScriptTransformer(
    pluginOptions,
    require('os').cpus().length - 1
  );

  return {
    name: 'angular-compiler',
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
        async ({ url, absolutePath }, _, __, ___, ____, { opts }) => {
          const name = path.basename(url);
          const source = await fs.readFile(absolutePath);

          const referenceId = this.emitFile({
            type: 'asset',
            name,
            source,
          });
          this.addWatchFile(absolutePath);
          fileReferenceIdMap.set(referenceId, {
            type: 'asset',
            name,
            source,
          });

          const referencingStyleFiles = resourceFileToStyleMap.get(absolutePath) ?? new Set();

          referencingStyleFiles.add(opts.from);

          resourceFileToStyleMap.set(absolutePath, referencingStyleFiles);

          return `%%${referenceId}%%`;
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
          const files = sourceFileToStyleMap.get(context.containingFile) ?? new Set();

          files.add(context.resourceFile);

          sourceFileToStyleMap.set(context.containingFile, files);
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
          const affectedFilePath = pathToFileURL(affected.fileName).href;

          sourceFileToStyleMap.delete(affectedFilePath);
          sourceFileCache.typeScriptFileCache.delete(affectedFilePath);
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

      for (const [, asset] of fileReferenceIdMap) {
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
      if (fileReferenceIdMap.has(referenceId)) {
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
        let content = sourceFileCache?.typeScriptFileCache.get(pathToFileURL(request).href);

        if (content === undefined) {
          const typescriptResult = await fileEmitter(id);

          if (!typescriptResult) {
            throw new Error(id + ' is not in typescript compilation');
          }

          const data = typescriptResult.content ?? '';
          // The pre-transformed data is used as a cache key. Since the cache is memory only,
          // the options cannot change and do not need to be represented in the key. If the
          // cache is later stored to disk, then the options that affect transform output
          // would need to be added to the key as well.
          content = babelDataCache.get(data);
          if (content === undefined) {
            content = await javascriptTransformer.transformData(request, data, true, true);

            babelDataCache.set(data, content);
          }

          sourceFileCache?.typeScriptFileCache.set(pathToFileURL(request).href, content);
        }

        const resourceFiles = sourceFileToStyleMap.get(request) ?? new Set();

        for (const resourceFile of resourceFiles) {
          this.addWatchFile(resourceFile);
        }

        return content;
      } else if (/\.[cm]?js$/.test(id)) {
        let content = sourceFileCache?.babelFileCache.get(id);

        if (content === undefined) {
          content = await javascriptTransformer.transformData(id, code);

          sourceFileCache?.babelFileCache.set(id, content);
        }

        return content;
      }

      return null;
    },
    watchChange(id) {
      const needInvalidationSourceFiles = new Set();

      function invalidateStyleFile(fileId) {
        for (const [key, files] of sourceFileToStyleMap) {
          if (files.has(fileId)) {
            files.delete(fileId);
            needInvalidationSourceFiles.add(fileId);

            sourceFileToStyleMap.set(key, files);
          }
        }
      }

      if (resourceFileToStyleMap.has(id)) {
        const styleFiles = resourceFileToStyleMap.get(id);

        for (const styleFile of styleFiles) {
          invalidateStyleFile(styleFile);
        }

        resourceFileToStyleMap.delete(id);
      }

      sourceFileCache.invalidate([...needInvalidationSourceFiles]);
    },
  };
};
