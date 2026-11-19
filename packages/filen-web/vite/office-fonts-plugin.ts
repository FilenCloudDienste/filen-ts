import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, extname, join } from "node:path"
import type { Plugin } from "vite"
import { type PinnedFile, record, serveListedFiles, verifyPinned } from "./shared"

// @filen/office's bundled document fonts and their licence files, served from 'self' (CSP font-src). A
// build emits each face under /assets/ with its manifest SHA-256 in the name (cached as immutable, like
// every other asset there); `virtual:office-fonts` maps each manifest path to that URL for the viewer, whose
// worker fetches the bytes and registers them with `new FontFace`. The licence files keep their manifest
// paths under OFFICE_FONTS_BASE (unhashed, so revalidated). The dev server serves everything from
// OFFICE_FONTS_BASE. The handwriting faces of the PDF signature dialog are served the same way and listed apart in
// `virtual:office-signature-fonts`, each with the unicode-range of its cmap.
export const OFFICE_FONTS_BASE = "/office/fonts/"

const VIRTUAL_ID = "virtual:office-fonts"
const RESOLVED_ID = `\0${VIRTUAL_ID}`
const PDF_VIRTUAL_ID = "virtual:office-pdf-fonts"
const PDF_RESOLVED_ID = `\0${PDF_VIRTUAL_ID}`
const SIGNATURE_VIRTUAL_ID = "virtual:office-signature-fonts"
const SIGNATURE_RESOLVED_ID = `\0${SIGNATURE_VIRTUAL_ID}`

// A face's URL in a build: its manifest path with the first 8 hex digits of its SHA-256 before the extension.
function hashedPath(face: Face): string {
	const extension = extname(face.file)

	return `assets/office-fonts/${face.file.slice(0, -extension.length)}-${face.sha256.slice(0, 8)}${extension}`
}

const FONTS_DIR = dirname(createRequire(import.meta.url).resolve("@filen/office/assets/fonts/manifest.json"))
const MANIFEST = join(FONTS_DIR, "manifest.json")
// The .ttf.gz faces are sent as stored (no Content-Encoding): the worker decompresses them itself.
const MIME: Record<string, string> = { ".woff2": "font/woff2", ".gz": "application/gzip", ".txt": "text/plain; charset=utf-8" }

type Face = PinnedFile

function faceOf(value: unknown, owner: string): Face {
	const { file, bytes, sha256 } = record(value)

	if (typeof file !== "string" || typeof bytes !== "number" || typeof sha256 !== "string") {
		throw new Error(`${MANIFEST}: a face of ${owner} is malformed`)
	}

	return { file, bytes, sha256 }
}

interface SignatureFace extends Face {
	id: string
	unicodeRange: string
}

// The signature families, one face each, in the manifest's order (the dialog's first style is its default).
function signatureFacesOf(value: unknown, licences: Set<string>): SignatureFace[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${MANIFEST} lists no signature families`)
	}

	return value.map(record).map(family => {
		const id = family["id"]
		const licence = family["licenseFile"]
		const familyFaces = family["faces"]
		const first: unknown = Array.isArray(familyFaces) && familyFaces.length === 1 ? familyFaces[0] : undefined
		const unicodeRange = record(first)["unicodeRange"]

		if (typeof id !== "string" || typeof licence !== "string" || typeof unicodeRange !== "string") {
			throw new Error(`${MANIFEST}: signature family ${String(id)} is malformed`)
		}

		licences.add(licence)

		return { ...faceOf(first, id), id, unicodeRange }
	})
}

// Every face (web fonts, and the PDF and signature faces apart) and each family's licence file, as paths under the
// fonts directory.
function readManifest(): { faces: Face[]; pdfFaces: Face[]; signatureFaces: SignatureFace[]; licences: string[] } {
	const manifest = record(JSON.parse(readFileSync(MANIFEST, "utf8")))
	const families = manifest["families"]
	const fallbacks = manifest["fallbacks"]
	const faces: Face[] = []
	const pdfFaces: Face[] = []
	const licences = new Set<string>()
	const signatureFaces = signatureFacesOf(manifest["signatures"], licences)

	if (!Array.isArray(families) || families.length === 0) {
		throw new Error(`${MANIFEST} lists no families`)
	}

	const groups = [
		{ list: families, web: true },
		{ list: Array.isArray(fallbacks) ? fallbacks : [], web: false }
	]

	for (const { list, web } of groups) {
		for (const family of list.map(record)) {
			const licence = family["licenseFile"]
			const familyFaces = family["faces"]
			const pdf = family["pdf"]
			const owner = String(family["id"])

			if (typeof licence !== "string" || !Array.isArray(familyFaces) || familyFaces.length === 0) {
				throw new Error(`${MANIFEST}: family ${owner} is malformed`)
			}

			// A family's "faces" are web fonts; a fallback's are PDF faces, as is every family's "pdf" list.
			for (const face of familyFaces) {
				;(web ? faces : pdfFaces).push(faceOf(face, owner))
			}

			if (Array.isArray(pdf)) {
				for (const face of pdf) {
					pdfFaces.push(faceOf(face, owner))
				}
			}

			licences.add(licence)
		}
	}

	return { faces, pdfFaces, signatureFaces, licences: [...licences] }
}

// `emit: false` is the workers' instance: the same virtual modules and URLs, without the dev middleware or the build's
// verify-and-emit (the page build emits every file once).
export function officeFonts(options: { readonly emit?: boolean } = {}): Plugin {
	const { faces, pdfFaces, signatureFaces, licences } = readManifest()
	const urlOf = (face: Face) => (build ? `/${hashedPath(face)}` : OFFICE_FONTS_BASE + face.file)
	let build = false

	const plugin: Plugin = {
		name: options.emit === false ? "filen:office-fonts-modules" : "filen:office-fonts",
		configResolved(config) {
			build = config.command === "build"
		},
		resolveId(id) {
			return id === VIRTUAL_ID
				? RESOLVED_ID
				: id === PDF_VIRTUAL_ID
					? PDF_RESOLVED_ID
					: id === SIGNATURE_VIRTUAL_ID
						? SIGNATURE_RESOLVED_ID
						: null
		},
		load(id) {
			if (id === SIGNATURE_RESOLVED_ID) {
				const list = signatureFaces.map(face => ({ id: face.id, url: urlOf(face), unicodeRange: face.unicodeRange }))

				return `export const OFFICE_SIGNATURE_FONTS = Object.freeze(${JSON.stringify(list)})\n`
			}

			if (id !== RESOLVED_ID && id !== PDF_RESOLVED_ID) {
				return null
			}

			const list = id === RESOLVED_ID ? faces : pdfFaces
			const urls = Object.fromEntries(list.map(face => [face.file, urlOf(face)]))

			return `export const ${id === RESOLVED_ID ? "OFFICE_FONT_URLS" : "OFFICE_PDF_FONT_URLS"} = Object.freeze(${JSON.stringify(urls)})\n`
		}
	}

	if (options.emit === false) return plugin

	// Exactly the manifest's files, so the dev middleware needs no path containment of its own.
	const served = new Set([...[...faces, ...pdfFaces, ...signatureFaces].map(face => face.file), ...licences])
	const outDir = OFFICE_FONTS_BASE.slice(1)

	return {
		...plugin,
		configureServer(server) {
			serveListedFiles(server, {
				base: OFFICE_FONTS_BASE,
				dir: FONTS_DIR,
				served,
				mime: rel => MIME[extname(rel)] ?? "application/octet-stream"
			})
		},
		generateBundle() {
			for (const face of [...faces, ...pdfFaces, ...signatureFaces]) {
				const source = readFileSync(join(FONTS_DIR, face.file))

				verifyPinned(this, source, face)

				this.emitFile({ type: "asset", fileName: hashedPath(face), source })
			}

			for (const licence of licences) {
				this.emitFile({ type: "asset", fileName: outDir + licence, source: readFileSync(join(FONTS_DIR, licence)) })
			}
		}
	}
}
