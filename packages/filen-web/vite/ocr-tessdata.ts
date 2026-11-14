import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { gzip as gzipCallback, gzipSync } from "node:zlib"

// The text recognition models (tessdata_fast, Apache-2.0) the app serves, pinned to one upstream commit. Committed:
// ocr-tessdata.json, each model's size and SHA-256 and its gzip size (what a user downloads). Downloaded, verified,
// never committed: the models themselves, cached under node_modules/.cache at build start (and by the dev server
// on first request). scripts/ocr-tessdata.ts rewrites the manifest for a new commit or language set.

export const TESSDATA_REPOSITORY = "https://github.com/tesseract-ocr/tessdata_fast"

export const TESSDATA_MANIFEST = fileURLToPath(new URL("ocr-tessdata.json", import.meta.url))

// Level 9: the size the manifest records is what the build emits.
export const TESSDATA_GZIP_LEVEL = 9

const gzip = promisify(gzipCallback)

export interface TessdataFile {
	readonly file: string
	readonly bytes: number
	readonly sha256: string
}

export interface TessdataLanguage extends TessdataFile {
	readonly code: string
	// The gzip-compressed model's size: the one-time download.
	readonly gzipBytes: number
}

export interface TessdataManifest {
	readonly repository: string
	readonly commit: string
	readonly license: TessdataFile
	readonly languages: readonly TessdataLanguage[]
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}

function fileOf(value: unknown, where: string): TessdataFile {
	const { file, bytes, sha256 } = record(value)

	if (
		typeof file !== "string" ||
		!/^[\w.-]+$/.test(file) ||
		typeof bytes !== "number" ||
		typeof sha256 !== "string" ||
		!/^[0-9a-f]{64}$/.test(sha256)
	) {
		throw new Error(`${TESSDATA_MANIFEST}: ${where} is malformed`)
	}

	return { file, bytes, sha256 }
}

export function readTessdataManifest(): TessdataManifest {
	const manifest = record(JSON.parse(readFileSync(TESSDATA_MANIFEST, "utf8")))
	const { repository, commit, license, languages } = manifest

	if (typeof repository !== "string" || typeof commit !== "string" || !/^[0-9a-f]{40}$/.test(commit) || !Array.isArray(languages)) {
		throw new Error(`${TESSDATA_MANIFEST} is malformed`)
	}

	return {
		repository,
		commit,
		license: fileOf(license, "license"),
		languages: languages.map(record).map(language => {
			const { code, gzipBytes } = language

			if (typeof code !== "string" || typeof gzipBytes !== "number") throw new Error(`${TESSDATA_MANIFEST}: a language is malformed`)

			return { ...fileOf(language, code), code, gzipBytes }
		})
	}
}

export function tessdataCache(commit: string): string {
	return fileURLToPath(new URL(`../node_modules/.cache/filen-ocr-tessdata/${commit}/`, import.meta.url))
}

export function tessdataUrl(commit: string, file: string): string {
	return `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${commit}/${file}`
}

export function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex")
}

// A pinned file, downloaded once into the cache and checked against its pin; null pin = any content (the update).
async function cached(commit: string, file: string, pin: TessdataFile | null): Promise<Uint8Array> {
	const path = join(tessdataCache(commit), file)
	const matches = (bytes: Uint8Array): boolean => pin === null || (bytes.byteLength === pin.bytes && sha256(bytes) === pin.sha256)

	if (existsSync(path)) {
		const held = new Uint8Array(readFileSync(path))

		if (matches(held)) return held
	}

	const response = await fetch(tessdataUrl(commit, file))

	if (!response.ok) throw new Error(`tessdata ${file}: HTTP ${String(response.status)}`)

	const bytes = new Uint8Array(await response.arrayBuffer())

	if (!matches(bytes)) throw new Error(`tessdata ${file} does not match its pinned size and SHA-256`)

	mkdirSync(dirname(path), { recursive: true })
	// Written whole, then renamed: a parallel build never reads half a file.
	writeFileSync(`${path}.part`, bytes)
	renameSync(`${path}.part`, path)

	return bytes
}

// Every pinned file (or those named) present and verified in the cache; returns the cache directory.
export async function ensureTessdata(manifest: TessdataManifest, codes?: readonly string[]): Promise<string> {
	const wanted = codes === undefined ? manifest.languages : manifest.languages.filter(language => codes.includes(language.code))
	const queue: TessdataFile[] = [manifest.license, ...wanted]

	await Promise.all(
		Array.from({ length: 6 }, async () => {
			for (let file = queue.shift(); file !== undefined; file = queue.shift()) await cached(manifest.commit, file.file, file)
		})
	)

	return tessdataCache(manifest.commit)
}

// A cached model's gzip at TESSDATA_GZIP_LEVEL, compressed once per machine and kept beside it (named by its hash).
export async function gzippedTessdata(dir: string, language: TessdataLanguage): Promise<Uint8Array> {
	const path = join(dir, `${language.file}-${language.sha256.slice(0, 16)}.gz`)

	if (existsSync(path)) return new Uint8Array(readFileSync(path))

	const body = await gzip(readFileSync(join(dir, language.file)), { level: TESSDATA_GZIP_LEVEL })

	writeFileSync(`${path}.part`, body)
	renameSync(`${path}.part`, path)

	return body
}

// The manifest for `commit` and these languages, read from upstream (maintainers).
export async function buildTessdataManifest(commit: string, codes: readonly string[]): Promise<TessdataManifest> {
	const describe = (file: string, bytes: Uint8Array): TessdataFile => ({ file, bytes: bytes.byteLength, sha256: sha256(bytes) })
	const license = await cached(commit, "LICENSE", null)
	const languages: TessdataLanguage[] = []

	for (const code of codes) {
		const file = `${code}.traineddata`
		const bytes = await cached(commit, file, null)

		languages.push({ code, ...describe(file, bytes), gzipBytes: gzipSync(bytes, { level: TESSDATA_GZIP_LEVEL }).byteLength })
	}

	return { repository: TESSDATA_REPOSITORY, commit, license: describe("LICENSE", license), languages }
}
