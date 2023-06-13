const path = require('path');
const { pathToFileURL } = require('url');
const ts = require('typescript');
const { getSupportedBrowsers } = require('@angular-devkit/build-angular/src/utils/supported-browsers');
const { transformSupportedBrowsersToTargets } = require('@angular-devkit/build-angular/src/utils/esbuild-targets');
const { bundleComponentStylesheet } = require('@angular-devkit/build-angular/src/builders/browser-esbuild/stylesheets/bundle-options');
const { SourceFileCache } = require('@angular-devkit/build-angular/src/builders/browser-esbuild/angular/compiler-plugin');
const { AotCompilation } = require('@angular-devkit/build-angular/src/builders/browser-esbuild/angular/aot-compilation');
const { convertTypeScriptDiagnostic } = require('@angular-devkit/build-angular/src/builders/browser-esbuild/angular/diagnostics');
const { JavaScriptTransformer } = require('@angular-devkit/build-angular/src/builders/browser-esbuild/javascript-transformer');

module.exports = function angularCompiler(pluginOptions) {
  let resolveModule;
  const sourceFileCache = new SourceFileCache('node_modules/.cache');
  const compilation = new AotCompilation();
  const javascriptTransformer = new JavaScriptTransformer(
    pluginOptions,
    require('os').cpus().length - 1
  );
  const workspaceRoot = process.cwd();
  const projectRoot = process.cwd();

  return {
    name: 'angular-compiler',
    async buildStart() {
      let warnings = [];
      let errors = [];
      const browsers = getSupportedBrowsers(projectRoot, {
        warn: text => this.warn(text)
      });
      const target = transformSupportedBrowsersToTargets(browsers);
      const stylesheetResourceFiles = [];
      const stylesheetMetafiles = [];

      const { referencedFiles, compilerOptions } = await compilation.initialize(pluginOptions.tsconfig, {
        fileReplacements: pluginOptions.fileReplacements,
        modifiedFiles: sourceFileCache.modifiedFiles,
        sourceFileCache: sourceFileCache,
        transformStylesheet: async (data, containingFile, stylesheetFile) => {
          // Stylesheet file only exists for external stylesheets
          const filename = stylesheetFile ?? containingFile;

          const stylesheetResult = await bundleComponentStylesheet(
            'less',
            data,
            filename,
            !stylesheetFile,
            {
              workspaceRoot,
              optimization: pluginOptions.advancedOptimizations,
              sourcemap: pluginOptions.sourcemap,
              target,
              browsers
            },
            sourceFileCache.loadResultCache,
          );

          const { contents, resourceFiles, errors, warnings } = stylesheetResult;

          if (errors) {
            errors.push(...errors);
          }

          warnings.push(...warnings);

          stylesheetResourceFiles.push(...resourceFiles);

          if (stylesheetResult.metafile) {
            stylesheetMetafiles.push(stylesheetResult.metafile);
          }

          return contents;
        }
      }, compilerOptions => {
        if (sourceFileCache?.persistentCachePath) {
          compilerOptions.incremental ??= true;
          // Set the build info file location to the configured cache directory
          compilerOptions.tsBuildInfoFile = path.join(
            sourceFileCache?.persistentCachePath,
            '.tsbuildinfo',
          );
        } else {
          compilerOptions.incremental = false;
        }

        return {
          ...compilerOptions,
          noEmitOnError: false,
          inlineSources: pluginOptions.sourcemap,
          inlineSourceMap: pluginOptions.sourcemap,
          mapRoot: undefined,
          sourceRoot: undefined
        };
      });

      for (const diagnostic of compilation.collectDiagnostics()) {
        const message = convertTypeScriptDiagnostic(diagnostic);
        if (diagnostic.category === ts.DiagnosticCategory.Error) {
          errors.push(message);
        } else {
          warnings.push(message);
        }
      }

      for (const { filename, contents } of compilation.emitAffectedFiles()) {
        sourceFileCache.typeScriptFileCache.set(pathToFileURL(filename).href, contents);
      }

      sourceFileCache.referencedFiles = referencedFiles;

      for (const file of stylesheetResourceFiles) {
        this.emitFile({
          type: 'asset',
          fileName: file.path,
          source: file.contents
        });
      }

      const cache = ts.createModuleResolutionCache(
        workspaceRoot,
        fileName => ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase(),
        compilerOptions
      );

      resolveModule = (moduleName, containingFile) =>
        ts.resolveModuleName(moduleName, containingFile, compilerOptions, ts.sys, cache)
          .resolvedModule;

      if (errors) {
        for (const error of errors) {
          this.error(error.text, error.location);
        }
      }
      for (const warning of warnings) {
        this.warn(warning.text, warning.location);
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
    async transform(code, id) {
      if (/\.[cm]?tsx?$/.test(id)) {
        const request = pluginOptions.fileReplacements?.[id] ?? id;

        let content = sourceFileCache?.typeScriptFileCache.get(pathToFileURL(request).href);

        if (content === undefined) {
          throw new Error('Missing Typescript File ' + request);
        } else if (typeof content === 'string') {
          content = await javascriptTransformer.transformData(request, content, true);

          sourceFileCache?.typeScriptFileCache.set(pathToFileURL(request).href, content);
        }

        return Buffer.from(content).toString('UTF-8');
      } else if (/\.[cm]?js$/.test(id)) {
        let content = sourceFileCache?.babelFileCache.get(id);

        if (content === undefined) {
          content = await javascriptTransformer.transformData(id, code);

          sourceFileCache?.babelFileCache.set(id, content);
        }

        return Buffer.from(content).toString('UTF-8');
      }

      return null;
    }
  };
};
