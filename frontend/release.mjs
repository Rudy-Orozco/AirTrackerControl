/**
 * Publishes a release (npm run release [patch|minor|major], default patch):
 * asks what changed, adds it to CHANGELOG.md, bumps the version in
 * package.json, then commits everything, tags it and pushes. The Release
 * workflow (.github/workflows/release.yml) builds and publishes it from there,
 * and installed copies update themselves.
 *
 * If CHANGELOG.md already has a section for the new version, its notes are
 * kept and anything typed is added to them.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const FRONTEND = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(FRONTEND, '..')
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md')
const REPO = 'Rudy-Orozco/AirTrackerControl'

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const fail = (message) => {
  console.error(`\n${message}`)
  process.exit(1)
}

// ---- Checks --------------------------------------------------------------------------

const bump = process.argv[2] ?? 'patch'
if (!['patch', 'minor', 'major'].includes(bump)) fail(`Unknown bump "${bump}": use patch, minor or major.`)
if (git('branch', '--show-current') !== 'main') fail('Release from the main branch.')

git('fetch', '--tags', 'origin')
if (git('rev-list', '--count', 'HEAD..origin/main') !== '0') fail('main is behind GitHub: git pull first.')

const pkgFile = path.join(FRONTEND, 'package.json')
const current = JSON.parse(readFileSync(pkgFile, 'utf8')).version
const version = nextVersion(current, bump)
const tag = `v${version}`
if (git('tag', '--list', tag)) fail(`Tag ${tag} already exists. Delete it (git tag -d ${tag}; git push origin --delete ${tag}) or bump further.`)

// ---- Notes ---------------------------------------------------------------------------

const changelog = readFileSync(CHANGELOG, 'utf8')
const existing = sectionNotes(changelog, version)
const lastTag = git('tag', '--list', 'v*', '--sort=-v:refname').split('\n')[0]

console.log(`\nRelease ${current} -> ${version}\n`)
if (lastTag) {
  const commits = git('log', '--oneline', `${lastTag}..HEAD`)
  if (commits) console.log(`Commits since ${lastTag}:\n${indent(commits)}\n`)
}
const changed = git('status', '--short')
if (changed) console.log(`Uncommitted changes (included in the release):\n${indent(changed)}\n`)
if (existing.length) console.log(`Already in CHANGELOG.md for ${version}:\n${indent(existing.map((n) => `- ${n}`).join('\n'))}\n`)

const rl = createInterface({ input: stdin, output: stdout })
console.log('What changed? One line each, empty line to finish.')
const typed = []
for (;;) {
  const line = (await rl.question('- ')).trim().replace(/^[-*]\s*/, '')
  if (!line) break
  typed.push(line)
}
const notes = [...existing, ...typed]
if (!notes.length) {
  rl.close()
  fail('No notes: nothing released.')
}

console.log(`\n## ${version} — ${today()}\n${notes.map((n) => `- ${n}`).join('\n')}\n`)
const ok = (await rl.question(`Commit, tag ${tag} and push? [y/N] `)).trim().toLowerCase()
rl.close()
if (ok !== 'y' && ok !== 'yes') fail('Cancelled: nothing changed.')

// ---- Release -------------------------------------------------------------------------

writeFileSync(CHANGELOG, withSection(changelog, version, notes))
setVersion(pkgFile, version)
setVersion(path.join(FRONTEND, 'package-lock.json'), version)

git('add', '-A')
git('commit', '-m', `${tag}: ${notes[0]}`)
git('tag', tag)
git('push', 'origin', 'main')
git('push', 'origin', tag)

console.log(`
Pushed ${tag}. GitHub is building it now (5-10 minutes):
  https://github.com/${REPO}/actions
Installed apps pick it up within the hour. Latest installer:
  https://github.com/${REPO}/releases/latest/download/AirTrackerControl-Setup.exe
`)

// ---- Helpers -------------------------------------------------------------------------

function nextVersion(v, kind) {
  const [major, minor, patch] = v.split('.').map(Number)
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

function today() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function indent(text) {
  return text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n')
}

/** The `- ` lines of the version's section, if CHANGELOG.md has one. */
function sectionNotes(md, v) {
  const section = md.split(/^## /m).find((s) => s.split(/\s/)[0] === v)
  if (!section) return []
  return section
    .split(/\r?\n/)
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
}

/** CHANGELOG.md with the version's section (replacing any it had) above the other releases. */
function withSection(md, v, items) {
  const eol = md.includes('\r\n') ? '\r\n' : '\n'
  const section = [`## ${v} — ${today()}`, '', ...items.map((n) => `- ${n}`), '', ''].join(eol)
  const [head, ...releases] = md.split(/^(?=## )/m)
  const others = releases.filter((s) => s.slice(3).split(/\s/)[0] !== v)
  return head + section + others.join('')
}

/** Sets "version" in package.json or package-lock.json (the lock has it at the top and for the root package). */
function setVersion(file, v) {
  const text = readFileSync(file, 'utf8')
  const json = JSON.parse(text)
  json.version = v
  if (json.packages?.['']) json.packages[''].version = v
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  writeFileSync(file, JSON.stringify(json, null, 2).replace(/\n/g, eol) + eol)
}
