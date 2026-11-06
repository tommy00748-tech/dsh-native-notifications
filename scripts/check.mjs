#!/usr/bin/env node
/**
 * Repository gate: validates everything the Harness and the plugin market
 * validator will look at, without needing the Harness to be installed.
 *
 * Run with `node scripts/check.mjs` (also used by CI).
 */
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

const read = (name) => readFile(join(root, name), 'utf8')
const pkg = JSON.parse(await read('package.json'))

// ---- package manifest -------------------------------------------------------
check(typeof pkg.name === 'string' && /^[a-z0-9][a-z0-9._-]*$/u.test(pkg.name), 'package.json: name must be a plain npm name')
check(typeof pkg.version === 'string' && /^\d+\.\d+\.\d+$/u.test(pkg.version), 'package.json: version must be exact SemVer')
check(pkg.license === 'MIT', 'package.json: license must be MIT')
check(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json: dsh.bundle.patch must point at cordis.patch.yml')
check(pkg.dsh?.client?.platform === 'web', 'package.json: dsh.client.platform must be "web"')
check(typeof pkg.engines?.dsh === 'string' && pkg.engines.dsh.length > 0, 'package.json: top-level engines.dsh is required for runtime compatibility (0.2.2 ignores dsh.engines)')
check(pkg.dsh?.engines === undefined, 'package.json: move engines.dsh to the top-level engines field; dsh.engines is ignored')
check(pkg.private !== true, 'package.json: private must not be true for an npm release')
for (const key of ['repository', 'homepage', 'bugs']) {
  check(pkg[key] !== undefined, `package.json: ${key} is required for publishing`)
}

// ---- exports resolve --------------------------------------------------------
for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
  const entries = Array.isArray(target) ? target : [target]
  for (const entry of entries) {
    // Glob subpaths (`./locale/*.json`) describe a real directory of files.
    if (entry.includes('*')) {
      const directory = join(root, entry.slice(0, entry.indexOf('/') + 1))
      const info = await stat(directory).catch(() => undefined)
      check(info?.isDirectory() === true, `exports["${subpath}"]: ${directory} does not exist`)
      continue
    }
    const file = join(root, entry)
    const info = await stat(file).catch(() => undefined)
    check(info?.isFile() === true, `exports["${subpath}"]: ${entry} does not exist`)
  }
}

// ---- client bundle identity -------------------------------------------------
const client = await read('client.js')
check(
  client.includes(`id: '${pkg.name}'`) || client.includes(`id: "${pkg.name}"`),
  `client.js: __ModuleLoader__.load id must equal the package name (${pkg.name})`,
)
check(!/require\(\s*['"]host['"]\s*\)/u.test(client), 'client.js: require("host") is not available to persistent client halves')
check(!/dsh-client-ui-primitives/u.test(client), 'client.js: do not import Harness client packages or primitives')

// ---- locales and icon -------------------------------------------------------
const locale = JSON.parse(await read('locale/en.json'))
check(typeof locale?.meta?.title === 'string' && locale.meta.title.length > 0, 'locale/en.json: meta.title is required')
check(typeof locale?.meta?.description === 'string' && locale.meta.description.length > 0, 'locale/en.json: meta.description is required')
const localeZh = JSON.parse(await read('locale/zh.json'))
check(typeof localeZh?.meta?.title === 'string' && localeZh.meta.title.length > 0, 'locale/zh.json: meta.title is required')
const icon = await stat(join(root, 'icon.svg')).catch(() => undefined)
check(icon?.isFile() === true, 'icon.svg: missing')
check((icon?.size ?? 0) > 0 && (icon?.size ?? 0) <= 256 * 1024, 'icon.svg: must be a non-empty image under 256 KiB')

// ---- market index (format 1) ------------------------------------------------
const index = JSON.parse(await read('index.json'))
const isLang = (value) => value !== null && typeof value === 'object' && typeof value.en === 'string' && typeof value.zh === 'string'
check(index.format === 1, 'index.json: format must be 1')
check(isLang(index.title), 'index.json: title must carry en and zh strings')
check(isLang(index.description), 'index.json: description must carry en and zh strings')
check(Array.isArray(index.plugins) && index.plugins.length > 0, 'index.json: plugins must be a non-empty array')
const declaredCategories = new Set(Object.keys(index.metadata?.categories ?? {}))
const declaredLabels = new Set(Object.keys(index.metadata?.labels ?? {}))
const names = new Set()
for (const plugin of index.plugins ?? []) {
  check(typeof plugin.name === 'string' && plugin.name.length > 0, 'index.json: plugin.name is required')
  check(!names.has(plugin.name), `index.json: duplicate plugin name ${plugin.name}`)
  names.add(plugin.name)
  check(isLang(plugin.title), `index.json: ${plugin.name} title must carry en and zh`)
  check(isLang(plugin.description), `index.json: ${plugin.name} description must carry en and zh`)
  check(typeof plugin.author === 'string' && plugin.author.length > 0, `index.json: ${plugin.name} author is required`)
  check(typeof plugin.repository?.url === 'string' && /^https?:\/\//u.test(plugin.repository.url), `index.json: ${plugin.name} repository.url must be absolute`)
  check(typeof plugin.icon === 'string' && /^https?:\/\//u.test(plugin.icon), `index.json: ${plugin.name} icon must be an absolute URL`)
  if (plugin.category !== undefined) check(declaredCategories.has(plugin.category), `index.json: ${plugin.name} category "${plugin.category}" is not declared`)
  for (const label of plugin.labels ?? []) check(declaredLabels.has(label), `index.json: ${plugin.name} label "${label}" is not declared`)
  check(Array.isArray(plugin.versions) && plugin.versions.length > 0, `index.json: ${plugin.name} needs at least one version`)
  for (const version of plugin.versions ?? []) {
    check(/^\d+\.\d+\.\d+$/u.test(version.version ?? ''), `index.json: ${plugin.name} version must be exact SemVer`)
    check(Number.isInteger(version.publishTimestamp), `index.json: ${plugin.name} publishTimestamp must be integer seconds`)
    check(version.source?.type === 'npm' || version.source?.type === 'git', `index.json: ${plugin.name} source.type must be npm or git`)
  }
  const latest = pkg.name === plugin.name ? pkg.version : undefined
  if (latest !== undefined) check(plugin.versions.some((version) => version.version === latest), `index.json: ${plugin.name} must list the packaged version ${latest}`)
}

// ---- report -----------------------------------------------------------------
if (failures.length > 0) {
  console.error(`check failed (${failures.length}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log(`check passed: ${pkg.name}@${pkg.version}, ${index.plugins.length} market entry`)
}
