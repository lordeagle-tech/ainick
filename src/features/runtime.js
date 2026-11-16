'use strict';

const Module = require('node:module');
const path = require('node:path');

const definitions = new Map();
const cache = new Map();
const optionalAliases = new Set([
  'audioConvert', 'cardGame', 'cryptoZip', 'devTools', 'dynatools', 'gamehost',
  'gofile', 'marriage', 'newFeatures', 'pokemonHunt', 'quickGames', 'scrapers',
  'shop', 'socialGames', 'starboard', 'usageLimiter', 'webAutomate',
]);

function define(name, sourceName, factory) {
  if (definitions.has(name)) throw new Error(`Duplicate bundled feature: ${name}`);
  definitions.set(name, {
    filename: path.join(__dirname, sourceName),
    factory,
  });
}

function resolveBundledName(parentFilename, request) {
  if (typeof request !== 'string' || !request.startsWith('.')) return null;

  const resolved = path.resolve(path.dirname(parentFilename), request);
  const candidates = [
    resolved,
    `${resolved}.js`,
    `${resolved}.json`,
    path.join(resolved, 'index.js'),
  ];

  for (const candidate of candidates) {
    for (const [name, definition] of definitions) {
      if (definition.filename === candidate) return name;
    }
    if (path.dirname(candidate) === __dirname && path.extname(candidate) === '.js') {
      const alias = path.basename(candidate, '.js');
      if (optionalAliases.has(alias)) return alias;
    }
  }
  return null;
}

function load(name) {
  if (optionalAliases.has(name)) return load('optionalFeatures')[name];

  const cached = cache.get(name);
  if (cached) return cached.exports;

  const definition = definitions.get(name);
  if (!definition) throw new Error(`Unknown bundled feature: ${name}`);

  const { filename, factory } = definition;
  const module = {
    exports: {},
    id: filename,
    filename,
    loaded: false,
    parent: null,
    children: [],
    paths: Module._nodeModulePaths(path.dirname(filename)),
  };
  cache.set(name, module);

  const nativeRequire = Module.createRequire(filename);
  const localRequire = (request) => {
    const internalName = resolveBundledName(filename, request);
    if (internalName) return load(internalName);
    return nativeRequire(request);
  };
  localRequire.resolve = (request, options) => nativeRequire.resolve(request, options);
  localRequire.resolve.paths = nativeRequire.resolve.paths;
  localRequire.cache = nativeRequire.cache;
  localRequire.main = nativeRequire.main;
  localRequire.extensions = nativeRequire.extensions;
  module.require = localRequire;

  try {
    factory.call(module.exports, module, module.exports, localRequire, filename, path.dirname(filename));
    module.loaded = true;
    return module.exports;
  } catch (error) {
    cache.delete(name);
    throw error;
  }
}

function createRegistry() {
  const names = [...definitions.keys(), ...optionalAliases];
  return new Proxy(Object.create(null), {
    get(target, property) {
      if (typeof property === 'string' && names.includes(property)) return load(property);
      return undefined;
    },
    has(target, property) {
      return names.includes(property);
    },
    ownKeys() {
      return names;
    },
    getOwnPropertyDescriptor(target, property) {
      if (!names.includes(property)) return undefined;
      return { enumerable: true, configurable: true, get: () => load(property) };
    },
  });
}

module.exports = { define, createRegistry };
