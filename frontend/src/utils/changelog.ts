import raw from '../../../CHANGELOG.md?raw'

export interface Release {
  version: string
  date: string
  items: string[]
}

/** The releases in CHANGELOG.md, newest first: each `## <version> — <date>` heading and its `- ` lines. */
export const CHANGELOG: Release[] = raw
  .split(/^## /m)
  .slice(1)
  .map((section) => {
    const [heading, ...lines] = section.split(/\r?\n/)
    const [version, date = ''] = heading.split(/\s+[—-]\s+/)
    const items = lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim())
    return { version: version.trim(), date: date.trim(), items }
  })
