import { existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"

const PACKAGE = join(import.meta.dirname, "..", "..")
// `pnpm run corpus:fetch` writes its copy of the manifest last; the legacy location carries MANIFEST.json.
const CACHE = join(PACKAGE, ".corpus")
const CANDIDATES = [CACHE, join(PACKAGE, "..", "filen-web", "docs", "office", "corpus")]

function corpusDir(): string {
	const configured = process.env["FILEN_OFFICE_CORPUS"]

	if (configured !== undefined && configured !== "") {
		if (!existsSync(configured)) throw new Error(`FILEN_OFFICE_CORPUS does not exist: ${configured}`)

		return resolve(configured)
	}

	return (
		CANDIDATES.find(directory => existsSync(join(directory, "manifest.json")) || existsSync(join(directory, "MANIFEST.json"))) ?? CACHE
	)
}

// The licensed real-world corpus (corpus/manifest.json), which is never committed: FILEN_OFFICE_CORPUS when set
// (it must exist), else the cache `pnpm run corpus:fetch` fills, else the legacy location. Corpus tests skip
// while this directory does not exist.
export const CORPUS_DIR = corpusDir()

// The corpus's files of `extensions` (its directory per extension), each directory's in name order.
export function corpusFiles(extensions: readonly string[]): string[] {
	const files: string[] = []

	for (const extension of extensions) {
		const directory = join(CORPUS_DIR, extension)

		if (!existsSync(directory)) continue

		for (const name of readdirSync(directory).sort()) files.push(join(directory, name))
	}

	return files
}
