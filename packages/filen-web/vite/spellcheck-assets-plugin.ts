import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import { gzip as gzipCallback } from "node:zlib"
import type { Plugin } from "vite"
import { WASM_PATH, buildWasm } from "@filen/spellcheck/build-wasm"
import { COI_HEADERS, type PinnedFile, record, sha256, verifyPinned } from "./shared"

// @filen/spellcheck's wasm engine, its dictionaries and their licence files, served from 'self'. The engine
// is built from source (cargo, incremental) and the dictionaries from their pinned upstream sources into
// packages/filen-spellcheck/.dictionaries (never committed; verified against the manifest) at build start;
// the dev server does both on first request. A build emits the engine and each dictionary file under
// /assets/spellcheck/ with the first 8 hex digits of its SHA-256 in the name (immutable). Dictionary files
// are gzip-compressed here and named .bin, not .gz: served as opaque bytes, no host or CDN compresses them
// again or adds a Content-Encoding the browser would undo first; the worker inflates them straight into
// wasm memory (and takes them uncompressed too), so the 49 MB set is about 13 MB on the wire.
// `virtual:spellcheck-assets` gives the host every URL with the manifest's size and SHA-256 of the
// uncompressed file, which the worker verifies. Licence files keep their manifest paths under
// SPELLCHECK_BASE/dictionaries/ (unhashed, so revalidated).
export const SPELLCHECK_BASE = "/spellcheck/"

const VIRTUAL_ID = "virtual:spellcheck-assets"
const RESOLVED_ID = `\0${VIRTUAL_ID}`
const PACKAGE_DIR = dirname(createRequire(import.meta.url).resolve("@filen/spellcheck/package.json"))
// Committed: the manifest and each dictionary's notice files.
const DICTIONARIES_DIR = join(PACKAGE_DIR, "dictionaries")
const MANIFEST = join(DICTIONARIES_DIR, "manifest.json")
// Built from the manifest's pinned sources, never committed: the .aff and .dic files.
const BUILT_DIR = join(PACKAGE_DIR, ".dictionaries")
const WASM_NAME = "filen_spellcheck.wasm"
// Licence and readme files, under SPELLCHECK_BASE.
const NOTICES = "dictionaries/"
const gzip = promisify(gzipCallback)

type ManifestFile = PinnedFile

interface ManifestDictionary {
	id: string
	aff: ManifestFile
	dic: ManifestFile
	notices: ManifestFile[]
}

function manifestFile(value: unknown, where: string): ManifestFile {
	const { file, bytes, sha256 } = record(value)

	if (typeof file !== "string" || typeof bytes !== "number" || typeof sha256 !== "string" || file.includes("..")) {
		throw new Error(`${MANIFEST}: ${where} is malformed`)
	}

	return { file, bytes, sha256 }
}

function readManifest(): ManifestDictionary[] {
	const dictionaries = record(JSON.parse(readFileSync(MANIFEST, "utf8")))["dictionaries"]

	if (!Array.isArray(dictionaries) || dictionaries.length === 0) {
		throw new Error(`${MANIFEST} lists no dictionaries`)
	}

	return dictionaries.map(record).map(dictionary => {
		const id = dictionary["id"]
		const notices = dictionary["notices"]

		if (typeof id !== "string" || !Array.isArray(notices)) {
			throw new Error(`${MANIFEST}: a dictionary is malformed`)
		}

		return {
			id,
			aff: manifestFile(dictionary["aff"], `${id}.aff`),
			dic: manifestFile(dictionary["dic"], `${id}.dic`),
			notices: notices.map(notice => manifestFile(notice, `${id} notice`))
		}
	})
}

// The package's build script (plain Node strips its types), in its default mode: build into .dictionaries/
// what is missing and verify every file against the manifest; a no-op once built.
function buildDictionaries(): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["scripts/build-dictionaries.ts"], {
			cwd: PACKAGE_DIR,
			stdio: ["ignore", "inherit", "inherit"]
		})

		child.on("error", reject)
		child.on("exit", code => {
			if (code === 0) resolve()
			else reject(new Error(`build-dictionaries exited with ${String(code)}`))
		})
	})
}

// A dictionary file's URL in a build: its name, the hash, ".bin".
function hashedPath(file: ManifestFile): string {
	return `assets/spellcheck/${file.file.replaceAll("/", "-")}-${file.sha256.slice(0, 8)}.bin`
}

export function spellcheckAssets(): Plugin {
	const dictionaries = readManifest()
	const files = new Map(dictionaries.flatMap(dictionary => [dictionary.aff, dictionary.dic]).map(file => [file.file, file]))
	const notices = new Map(dictionaries.flatMap(dictionary => dictionary.notices).map(file => [file.file, file]))
	let build = false
	let wasmUrl = `${SPELLCHECK_BASE}${WASM_NAME}`
	let wasm: Promise<unknown> | undefined

	// A dev server and the test runner only build the engine when a page first asks for it.
	let built: Promise<void> | undefined
	const ensureWasm = (): Promise<unknown> => (wasm ??= buildWasm())
	// Downloads, verifies and builds the dictionaries the first time; afterwards a stamp check.
	const ensureDictionaries = (): Promise<void> => (built ??= buildDictionaries())

	return {
		name: "filen:spellcheck-assets",
		configResolved(config) {
			build = config.command === "build"
		},
		async buildStart() {
			if (!build) {
				return
			}

			await Promise.all([ensureWasm(), ensureDictionaries()])
			wasmUrl = `/assets/spellcheck/filen_spellcheck-${sha256(readFileSync(WASM_PATH)).slice(0, 8)}.wasm`
		},
		resolveId(id) {
			return id === VIRTUAL_ID ? RESOLVED_ID : null
		},
		load(id) {
			if (id !== RESOLVED_ID) {
				return null
			}

			const url = (file: ManifestFile): string =>
				build ? `/${hashedPath(file)}` : `${SPELLCHECK_BASE}${file.file}.bin?v=${file.sha256.slice(0, 8)}`
			const asset = (file: ManifestFile) => ({ url: url(file), bytes: file.bytes, sha256: file.sha256 })
			const assets = {
				wasm: wasmUrl,
				dictionaries: Object.fromEntries(
					dictionaries.map(dictionary => [dictionary.id, { aff: asset(dictionary.aff), dic: asset(dictionary.dic) }])
				)
			}

			return `export const SPELLCHECK_ASSETS = Object.freeze(${JSON.stringify(assets)})\n`
		},
		// The preview serves the build's copies from dist/ instead, under the preview header set.
		configureServer(server) {
			server.middlewares.use((req, res, next) => {
				const path = (req.url ?? "").split("?")[0] ?? ""
				const rel = path.startsWith(SPELLCHECK_BASE) ? decodeURIComponent(path.slice(SPELLCHECK_BASE.length)) : null
				const dictionaryFile = rel?.endsWith(".bin") === true ? files.get(rel.slice(0, -4)) : undefined
				const notice = rel?.startsWith(NOTICES) === true ? notices.get(rel.slice(NOTICES.length)) : undefined

				if (rel === null || (rel !== WASM_NAME && dictionaryFile === undefined && notice === undefined)) {
					next()

					return
				}

				const send = (body: Uint8Array, type: string): void => {
					res.setHeader("Content-Type", type)
					res.setHeader("Content-Length", body.byteLength)

					for (const [name, value] of Object.entries(COI_HEADERS)) {
						res.setHeader(name, value)
					}

					res.end(body)
				}
				const fail = (error: unknown): void => {
					server.config.logger.error(`spellcheck: ${error instanceof Error ? error.message : String(error)}`)
					res.statusCode = 500
					res.end()
				}

				if (rel === WASM_NAME) {
					ensureWasm().then(() => {
						send(readFileSync(WASM_PATH), "application/wasm")
					}, fail)
				} else if (dictionaryFile !== undefined) {
					ensureDictionaries()
						.then(() => gzip(readFileSync(join(BUILT_DIR, dictionaryFile.file)), { level: 1 }))
						.then(body => {
							send(body, "application/octet-stream")
						}, fail)
				} else {
					send(readFileSync(join(DICTIONARIES_DIR, notice?.file ?? "")), "text/plain; charset=utf-8")
				}
			})
		},
		async generateBundle() {
			this.emitFile({ type: "asset", fileName: wasmUrl.slice(1), source: readFileSync(WASM_PATH) })

			// Compressed in parallel on the thread pool: about 49 MB of text.
			await Promise.all(
				[...files.values()].map(async file => {
					const source = readFileSync(join(BUILT_DIR, file.file))

					verifyPinned(this, source, file)

					this.emitFile({ type: "asset", fileName: hashedPath(file), source: await gzip(source, { level: 9 }) })
				})
			)

			for (const notice of notices.values()) {
				this.emitFile({
					type: "asset",
					fileName: `${SPELLCHECK_BASE.slice(1)}${NOTICES}${notice.file}`,
					source: readFileSync(join(DICTIONARIES_DIR, notice.file))
				})
			}
		}
	}
}
