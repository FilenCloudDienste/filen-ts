import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import type { Plugin } from "vite"
import { type PinnedFile, serveListedFiles, verifyPinned } from "./shared"

// @filen/office's hyphenation patterns (assets/hyphenation), served from 'self'. A build emits each file under
// /assets/office-hyphenation/ with the first 8 hex digits of its manifest SHA-256 in the name (immutable); the dev
// server serves them from OFFICE_HYPHENATION_BASE. `virtual:office-hyphenation` maps each manifest path to its URL
// for the document workers, which fetch a language the first time a document hyphenates text in it. Files are sent
// as stored (gzip, no Content-Encoding): the worker inflates them.
export const OFFICE_HYPHENATION_BASE = "/office/hyphenation/"

const VIRTUAL_ID = "virtual:office-hyphenation"
const RESOLVED_ID = `\0${VIRTUAL_ID}`
// Beside the fonts in @filen/office's assets.
const DIR = join(dirname(createRequire(import.meta.url).resolve("@filen/office/assets/fonts/manifest.json")), "..", "hyphenation")
const MANIFEST = join(DIR, "manifest.json")

type PatternFile = PinnedFile

function readManifest(): PatternFile[] {
	const parsed: unknown = JSON.parse(readFileSync(MANIFEST, "utf8"))
	const languages: unknown = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "languages") : undefined

	if (!Array.isArray(languages) || languages.length === 0) {
		throw new Error(`${MANIFEST} lists no languages`)
	}

	return languages.map((value: unknown) => {
		const record = typeof value === "object" && value !== null ? value : {}
		const file: unknown = Reflect.get(record, "file")
		const bytes: unknown = Reflect.get(record, "bytes")
		const sha256: unknown = Reflect.get(record, "sha256")

		if (typeof file !== "string" || typeof bytes !== "number" || typeof sha256 !== "string" || file.includes("/")) {
			throw new Error(`${MANIFEST}: a language is malformed`)
		}

		return { file, bytes, sha256 }
	})
}

function hashedPath(entry: PatternFile): string {
	return `assets/office-hyphenation/${entry.file.replace(/\.txt\.gz$/, "")}-${entry.sha256.slice(0, 8)}.txt.gz`
}

// `emit: false` is the workers' instance: the same virtual module and URLs, without the dev middleware or the build's
// verify-and-emit (the page build emits every file once).
export function officeHyphenation(options: { readonly emit?: boolean } = {}): Plugin {
	const files = readManifest()
	let build = false

	const plugin: Plugin = {
		name: options.emit === false ? "filen:office-hyphenation-modules" : "filen:office-hyphenation",
		configResolved(config) {
			build = config.command === "build"
		},
		resolveId(id) {
			return id === VIRTUAL_ID ? RESOLVED_ID : null
		},
		load(id) {
			if (id !== RESOLVED_ID) {
				return null
			}

			const urls = Object.fromEntries(
				files.map(entry => [entry.file, build ? `/${hashedPath(entry)}` : OFFICE_HYPHENATION_BASE + entry.file])
			)

			return `export const OFFICE_HYPHENATION_URLS = Object.freeze(${JSON.stringify(urls)})\n`
		}
	}

	if (options.emit === false) return plugin

	// Exactly the manifest's files, so the dev middleware needs no path containment of its own.
	const served = new Set(files.map(entry => entry.file))

	return {
		...plugin,
		configureServer(server) {
			serveListedFiles(server, { base: OFFICE_HYPHENATION_BASE, dir: DIR, served, mime: () => "application/gzip" })
		},
		generateBundle() {
			for (const entry of files) {
				const source = readFileSync(join(DIR, entry.file))

				verifyPinned(this, source, entry)

				this.emitFile({ type: "asset", fileName: hashedPath(entry), source })
			}
		}
	}
}
