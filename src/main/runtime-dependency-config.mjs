/**
 * Convert product-owned runtimeDependencies into AgentTool process config.
 *
 * AgentTool does not carry feature SDKs such as Playwright. The product can
 * inject Node package paths, import-register hooks, and artifact env vars here;
 * shell and terminal tools only pass that environment through to child processes.
 */

import path from "node:path";

const PLAYWRIGHT_BROWSER_DEPENDENCIES = [
  "playwright-browsers",
  "runtime.playwright-browsers"
];

const NODE_PACKAGE_DEPENDENCIES = [
  "node-package",
  "node-packages",
  "npm-package",
  "npm-packages"
];

export function createRuntimeDependencyConfig(runtimeDependencies = []) {
  const dependencies = normalizeRuntimeDependencies(runtimeDependencies);
  const runtimeEnv = {};
  const nodePackagePaths = [];
  const nodeImportRegisterPaths = [];
  const nodeOptions = [];
  const nodePackageNames = [];
  let playwrightBrowsersPath;

  for (const dependency of dependencies) {
    mergeRuntimeEnv(runtimeEnv, dependency.env);
    mergeRuntimeEnv(runtimeEnv, dependency.runtimeEnv);

    pushUnique(nodePackagePaths, collectNodePackagePaths(dependency));
    pushUnique(nodeImportRegisterPaths, collectStringList([
      dependency.nodeImportRegisterPath,
      dependency.nodeImportRegisterPaths,
      dependency.nodeRegisterPath,
      dependency.nodeRegisterPaths,
      dependency.esmRegisterPath,
      dependency.esmRegisterPaths
    ]));
    pushUnique(nodeOptions, collectStringList([
      dependency.nodeOption,
      dependency.nodeOptions
    ]));

    if (isNodePackageDependency(dependency)) {
      pushUnique(nodePackageNames, collectNodePackageNames(dependency));
    }

    if (matchesRuntimeDependency(dependency, PLAYWRIGHT_BROWSER_DEPENDENCIES)) {
      playwrightBrowsersPath = firstNonEmpty(
        dependency.browsersPath,
        dependency.browserCachePath,
        dependency.env?.PLAYWRIGHT_BROWSERS_PATH,
        dependency.runtimeEnv?.PLAYWRIGHT_BROWSERS_PATH,
        dependency.path,
        dependency.home,
        playwrightBrowsersPath
      );
    }
  }

  if (playwrightBrowsersPath) {
    runtimeEnv.PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath;
    runtimeEnv.AGENT_TOOL_PLAYWRIGHT_BROWSERS_PATH = playwrightBrowsersPath;
  }

  return removeUndefined({
    runtimeEnv: Object.keys(runtimeEnv).length > 0 ? runtimeEnv : undefined,
    nodePackagePaths: nodePackagePaths.length > 0 ? nodePackagePaths : undefined,
    nodeImportRegisterPaths: nodeImportRegisterPaths.length > 0 ? nodeImportRegisterPaths : undefined,
    nodeOptions: nodeOptions.length > 0 ? nodeOptions : undefined,
    nodePackageNames: nodePackageNames.length > 0 ? nodePackageNames : undefined,
    playwrightBrowsersPath
  });
}

function normalizeRuntimeDependencies(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([key, dependency]) => ({
    key,
    ...(dependency && typeof dependency === "object" ? dependency : { value: dependency })
  }));
}

function collectNodePackagePaths(dependency) {
  const explicitPaths = collectStringList([
    dependency.nodeModulesPath,
    dependency.nodeModulesPaths,
    dependency.nodeModulePath,
    dependency.nodeModulePaths,
    dependency.packageNodeModulesPath,
    dependency.packageNodeModulesPaths,
    dependency.nodePath,
    dependency.nodePaths
  ]);
  const packageRoot = firstNonEmpty(dependency.packageRoot, dependency.packagePath);
  if (packageRoot) explicitPaths.push(path.dirname(packageRoot));
  return explicitPaths;
}

function collectNodePackageNames(dependency) {
  return collectStringList([
    dependency.packageName,
    dependency.packageNames,
    dependency.packages,
    dependency.name,
    dependency.id
  ]).filter((name) => !NODE_PACKAGE_DEPENDENCIES.includes(name.toLowerCase()));
}

function collectStringList(values) {
  const output = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      output.push(...value.filter(isNonEmptyString));
    } else if (isNonEmptyString(value)) {
      output.push(value);
    }
  }
  return output;
}

function mergeRuntimeEnv(target, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  for (const [key, value] of Object.entries(source)) {
    if (isNonEmptyString(key) && value !== undefined && value !== null) {
      target[key] = String(value);
    }
  }
}

function isNodePackageDependency(dependency) {
  return matchesRuntimeDependency(dependency, NODE_PACKAGE_DEPENDENCIES)
    || collectNodePackagePaths(dependency).length > 0;
}

function matchesRuntimeDependency(dependency, candidates) {
  const values = [
    dependency?.key,
    dependency?.slot,
    dependency?.id,
    dependency?.type,
    dependency?.name
  ].filter(Boolean).map((value) => String(value).toLowerCase());
  return candidates.some((candidate) => values.includes(candidate.toLowerCase()));
}

function pushUnique(target, values) {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

function firstNonEmpty(...values) {
  return values.find(isNonEmptyString);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function removeUndefined(input) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  );
}
