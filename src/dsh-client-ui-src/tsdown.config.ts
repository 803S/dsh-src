/**
 * ui-src bundle config (self-contained): the standard client bundle shape
 * (ModuleLoader factory wrapper, react/react-dom/jsx-runtime externalized to
 * the host `require`) plus two custom plugins:
 *
 * 1. cssModulesInline — every `.module.css` import becomes a module that
 *    injects the hashed stylesheet through the `<style data-plugin-css>`
 *    channel and exports `{ className: hashedClassName }`. Hash prefix is
 *    derived per file from a stable digest of pluginId + file path; exact
 *    hash equality with the historical bundle is neither required nor
 *    attempted (the class names are internal to the injected sheet).
 * 2. rawCssInline — plain `.css` imports (the @xyflow global stylesheet)
 *    ride the same style-tag channel without hashing.
 *
 * The upstream build used the monorepo-internal `clientBundle()` helper,
 * which is not public; this config re-implements the equivalent output
 * contract. See docs/UI-SOURCE.md.
 */
import { readFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { defineConfig } from 'tsdown'
import { bundleAsync, browserslistToTargets } from 'lightningcss'

/** Virtual-id prefix for css-modules virtual modules (must not end in `.css`). */
const CSS_MODULE_PREFIX = '\0dsh-css-module:'
/** Virtual-id prefix for raw stylesheet modules. */
const RAW_CSS_PREFIX = '\0dsh-raw-css:'
/** Shared virtual-id suffix keeping ids off bundlers' css guards. */
const VIRTUAL_SUFFIX = '.mjs'

/** The loader id this bundle registers under (must match lib/ui-src.js wiring). */
const PLUGIN_ID = '@lihua_dis/dsh-src/ui-src'

/** Stable short hash prefix for one css-modules file (8 chars, base62-ish). */
function classPrefixFor(file: string): string {
  const digest = createHash('sha1').update(`${PLUGIN_ID}\u0000${file}`).digest('base64url')
  // Leading digit would make an invalid class token; force a letter head.
  const head = /^[0-9_-]/.test(digest[0]) ? 'x' + digest : digest
  return head.slice(0, 8)
}

/** Escape a class name for use inside a regex character class. */
function escapeForRegex(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Compile one css-modules source: returns { cssText, exports }. */
async function compileCssModule(file: string, source: string, prefix: string): Promise<{ cssText: string; exports: Record<string, string> }> {
  const result = await bundleAsync({
    filename: file,
    code: Buffer.from(source),
    cssModules: {
      pattern: `${prefix}_[local]`,
    },
    targets: { chrome: 110 << 16 },
  })
  const exports: Record<string, string> = {}
  for (const [local, named] of Object.entries(result.exports ?? {})) exports[local] = named.name
  return { cssText: result.code.toString(), exports }
}

/** Resolve an import specifier coming from `importer` to an absolute path. */
function resolveFrom(specifier: string, importer: string | undefined): string | undefined {
  const require = createRequire(importer ?? import.meta.url)
  try {
    return require.resolve(specifier, importer !== undefined ? { paths: [dirname(importer)] } : undefined)
  } catch {
    return undefined
  }
}

/**
 * Style-injection module factory shared by both channels — mirrors the
 * upstream runtime shape: idempotent on a `style[data-plugin-css="<tagId>"]`
 * sentinel, tags owned by the plugin id, removed by the host on unload.
 */
function styleModuleBody(cssText: string, tagId: string): string[] {
  return [
    `const css = ${JSON.stringify(cssText)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
}

/** Plugin: `.module.css` imports → hashed style injection + exports map. */
function cssModulesInline(): unknown {
  return {
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = source.startsWith('.')
        ? resolve(dirname(importer ?? '.'), source)
        : resolveFrom(source, importer)
      return abs === undefined ? null : CSS_MODULE_PREFIX + abs + VIRTUAL_SUFFIX
    },
    async load(id: string) {
      if (!id.startsWith(CSS_MODULE_PREFIX)) return null
      const fileId = id.slice(CSS_MODULE_PREFIX.length, -VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = (await readFile(fileId)).toString()
      const prefix = classPrefixFor(fileId)
      const { cssText, exports } = await compileCssModule(fileId, source, prefix)
      const lines = [
        ...styleModuleBody(cssText, `${PLUGIN_ID}/${fileId.split('/').pop()}`),
        `export default ${JSON.stringify(exports, null, '\t\t')};`,
      ]
      return lines.join('\n')
    },
  }
}

/** Plugin: plain `.css` imports → verbatim style injection (global sheets). */
function rawCssInline(): unknown {
  return {
    name: 'dsh-raw-css-inline',
    resolveId(source: string) {
      if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
      const abs = resolveFrom(source, undefined) ?? source
      return RAW_CSS_PREFIX + abs + VIRTUAL_SUFFIX
    },
    async load(id: string) {
      if (!id.startsWith(RAW_CSS_PREFIX)) return null
      const fileId = id.slice(RAW_CSS_PREFIX.length, -VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const css = (await readFile(fileId)).toString()
      const lines = [...styleModuleBody(css, `${PLUGIN_ID}/raw`), 'export default {};']
      return lines.join('\n')
    },
  }
}

/** The ModuleLoader factory prelude (host require serves react/jsx-runtime/react-dom). */
const WRAPPER_INTRO = `
window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PLUGIN_ID)},
\tfactory: (require) => {
\tvar module = { exports: {} };
\tvar exports = module.exports;
`.trimStart()

/** The ModuleLoader wrapper outro: hand the plugin exports back. */
const WRAPPER_OUTRO = `
\treturn module.exports;
\t}
});
`

/** Bake process.env.NODE_ENV for the browser (rolldown's define did not apply to these branches). */
function bakeNodeEnv(): unknown {
  return {
    name: 'dsh-bake-node-env',
    renderChunk(code: string) {
      return code.replaceAll('process.env.NODE_ENV', JSON.stringify('production'))
    },
  }
}

export default defineConfig({
  entry: ['src/client/index.ts'],
  outputOptions: () => ({
    // CJS shape: external react imports become `require(...)` calls that the
    // host loader's `factory(require)` serves — same contract as upstream.
    format: 'cjs',
    intro: WRAPPER_INTRO,
    outro: WRAPPER_OUTRO,
  }),
  // react / react-dom / react/jsx-runtime come from the host loader require;
  // @xyflow/react (+ its d3 deps) must be bundled into the artifact.
  noExternal: [/@xyflow\/react/, /^d3-/],
  external: [/^react(\/|$)/, /^react-dom$/],
  plugins: [bakeNodeEnv(), cssModulesInline(), rawCssInline()],
  dts: false,
  minify: false,
  sourcemap: false,
})
