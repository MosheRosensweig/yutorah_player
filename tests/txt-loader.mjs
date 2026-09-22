// Test-only ESM loader: maps *.js.txt imports to text (mirrors the
// Cloudflare Workers text-module behavior used in production).
// Usage: node --loader ./tests/txt-loader.mjs tests/...
import { readFile } from 'node:fs/promises';

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('.js.txt')) {
    return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.endsWith('.js.txt')) {
    const source = await readFile(new URL(url), 'utf8');
    return {
      format: 'module',
      source: 'export default ' + JSON.stringify(source) + ';',
      shortCircuit: true
    };
  }
  return next(url, context);
}
