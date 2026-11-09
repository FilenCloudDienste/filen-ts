import { createHash } from "node:crypto"
import { createReadStream, readFileSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import type { Plugin } from "vite"
import { COI_HEADERS } from "./sdk-artifacts-plugin"

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

interface PatternFile {
	file: string
	bytes: number
	sha256: string
}

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

export function officeHyphenation(): Plugin {
	const files = readManifest()
	// Exactly the manifest's files, so the dev middleware needs no path containment of its own.
	const served = new Set(files.map(entry => entry.file))
	let build = false

	return {
		name: "filen:office-hyphenation",
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
		},
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const path = (req.url ?? "").split("?")[0] ?? ""
				const rel = path.startsWith(OFFICE_HYPHENATION_BASE) ? path.slice(OFFICE_HYPHENATION_BASE.length) : null

				if (rel === null || !served.has(rel)) {
					next()

					return
				}

				const file = join(DIR, rel)

				res.setHeader("Content-Type", "application/gzip")
				res.setHeader("Content-Length", statSync(file).size)

				for (const [name, value] of Object.entries(COI_HEADERS)) {
					res.setHeader(name, value)
				}

				createReadStream(file)
					.on("error", () => {
						res.statusCode = 500
						res.end()
					})
					.pipe(res)
			})
		},
		generateBundle() {
			for (const entry of files) {
				const source = readFileSync(join(DIR, entry.file))
				const sha256 = createHash("sha256").update(source).digest("hex")

				if (sha256 !== entry.sha256 || source.byteLength !== entry.bytes) {
					this.error(
						`${entry.file} is ${String(source.byteLength)} bytes with SHA-256 ${sha256}; manifest.json says ${String(entry.bytes)} bytes, ${entry.sha256}`
					)
				}

				this.emitFile({ type: "asset", fileName: hashedPath(entry), source })
			}
		}
	}
}
