import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { hashFile, parseFeed, rewriteFeed } from "./feed.ts"

// Re-syncs sha512 and size in every latest*.yml with the files beside it: anything modified after electron-builder
// wrote the manifest (stapling a dmg) would otherwise fail the clients' download verification. With --check nothing
// is written and any difference, or a listed file that is missing, fails.
//
//   node scripts/feedHashes.ts [--check] [dir]   (dir defaults to release)

const { values, positionals } = parseArgs({ options: { check: { type: "boolean", default: false } }, allowPositionals: true })
const dir = positionals[0] ?? "release"
const manifests = (await readdir(dir)).filter(name => /^latest.*\.yml$/.test(name)).sort()
const failures: string[] = []

if (manifests.length === 0) {
	failures.push(`no latest*.yml in ${dir}`)
}

for (const manifest of manifests) {
	const manifestPath = path.join(dir, manifest)
	const text = await readFile(manifestPath, "utf8")
	const feed = parseFeed(text, manifest)
	const urls = new Set(feed.files.map(file => file.url))
	const root = feed.top.get("path")

	if (root !== undefined) {
		urls.add(root)
	}

	const actual = new Map<string, { sha512: string; size: number }>()

	for (const url of urls) {
		const hashed = await hashFile(path.join(dir, url))

		if (hashed) {
			actual.set(url, hashed)
		} else {
			failures.push(`${manifest} lists ${url}, which is not in ${dir}`)
		}
	}

	const { text: next, changed } = rewriteFeed(text, actual)

	if (changed.length === 0) {
		console.log(`${manifest}: hashes and sizes match`)

		continue
	}

	if (values.check) {
		failures.push(`${manifest}: stale sha512/size for ${changed.join(", ")}`)

		continue
	}

	await writeFile(manifestPath, next)
	console.log(`${manifest}: rewrote sha512/size for ${changed.join(", ")}`)
}

if (failures.length > 0) {
	for (const failure of failures) {
		console.error(`::error::${failure}`)
	}

	process.exit(1)
}
