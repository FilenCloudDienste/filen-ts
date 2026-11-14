import { type } from "arktype"

// The user's saved visual signatures and initials for PDF Fill & Sign, as stored (end-to-end encrypted, as a file the
// apps sync next to the office settings). Entries never change once saved: adding one and deleting one are the only
// edits, so devices merge by union, with deletions kept as tombstones that win over the entry.
//
// { "v": 1,
//   "items": [ { "id": "<uuid>", "role": "signature" | "initials", "at": <stamp>,
//                "kind": "strokes", "width": <int>, "height": <int>, "strokes": [[x, y, x, y, …], …] }
//            | { …, "kind": "image", "width": <px>, "height": <px>, "png": "<base64>" } ],
//   "deleted": { "<id>": <stamp>, … } }
//
// Strokes are integer units in a width × height box (y down, the longer side 1000), as the signature dialog
// normalises them; an image is a small PNG. Stamps are milliseconds since the epoch.

export const PDF_SIGNATURES_FILE_NAME = "pdf-signatures.v1.json"
export const PDF_SIGNATURES_VERSION = 1
// Saved entries per role; saving one more drops the oldest.
export const PDF_SIGNATURES_MAX_PER_ROLE = 8
// A saved image's PNG, before base64.
export const PDF_SIGNATURE_MAX_PNG_BYTES = 256 * 1024
// Bounds of the stroke data (the dialog's normalised output stays far below).
const MAX_UNITS = 4000
const MAX_STROKES = 200
const MAX_POINTS = 4000
// Deletions remembered; the oldest are forgotten beyond this.
const MAX_TOMBSTONES = 500

export type PdfSignatureRoleName = "signature" | "initials"

export interface SavedPdfSignatureStrokes {
	readonly kind: "strokes"
	readonly width: number
	readonly height: number
	readonly strokes: readonly (readonly number[])[]
}

export interface SavedPdfSignatureImage {
	readonly kind: "image"
	readonly width: number
	readonly height: number
	// Base64 of the PNG.
	readonly png: string
}

export type SavedPdfSignatureData = SavedPdfSignatureStrokes | SavedPdfSignatureImage

export interface SavedPdfSignature {
	readonly id: string
	readonly role: PdfSignatureRoleName
	readonly at: number
	readonly data: SavedPdfSignatureData
}

export interface PdfSignaturesDoc {
	readonly v: typeof PDF_SIGNATURES_VERSION
	// Newest first.
	readonly items: readonly SavedPdfSignature[]
	readonly deleted: ReadonlyMap<string, number>
}

// The file was written by a newer format: it must not be overwritten by this one.
export class PdfSignaturesVersionError extends Error {
	readonly version: unknown

	constructor(version: unknown) {
		super(`Unsupported PDF signatures version ${String(version)}`)
		this.name = "PdfSignaturesVersionError"
		this.version = version
	}
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u
const ID = /^[A-Za-z0-9-]{1,64}$/u

const common = {
	id: type("string").narrow(value => ID.test(value)),
	role: "'signature' | 'initials'",
	at: "number.integer",
	width: type("number.integer").narrow(value => value >= 1 && value <= MAX_UNITS),
	height: type("number.integer").narrow(value => value >= 1 && value <= MAX_UNITS)
} as const

const strokesEntry = type({
	...common,
	kind: "'strokes'",
	strokes: type("number.integer[]")
		.narrow(points => points.length >= 2 && points.length <= MAX_POINTS * 2 && points.length % 2 === 0)
		.array()
		.narrow(strokes => strokes.length >= 1 && strokes.length <= MAX_STROKES)
})

const imageEntry = type({
	...common,
	kind: "'image'",
	png: type("string").narrow(value => value.length > 0 && value.length <= Math.ceil(PDF_SIGNATURE_MAX_PNG_BYTES / 3) * 4 && BASE64.test(value))
})

const entry = strokesEntry.or(imageEntry)

export function emptyPdfSignatures(): PdfSignaturesDoc {
	return { v: PDF_SIGNATURES_VERSION, items: [], deleted: new Map() }
}

function newestFirst(a: SavedPdfSignature, b: SavedPdfSignature): number {
	return b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

function toSaved(raw: typeof entry.infer): SavedPdfSignature {
	const data: SavedPdfSignatureData =
		raw.kind === "strokes"
			? { kind: "strokes", width: raw.width, height: raw.height, strokes: raw.strokes }
			: { kind: "image", width: raw.width, height: raw.height, png: raw.png }

	return { id: raw.id, role: raw.role, at: raw.at, data }
}

// The document as stored: tombstoned entries dropped, newest first, at most MAX_TOMBSTONES deletions (newest kept).
function settle(items: Iterable<SavedPdfSignature>, deleted: ReadonlyMap<string, number>): PdfSignaturesDoc {
	const tombstones = new Map([...deleted].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_TOMBSTONES))
	const kept = [...items].filter(item => !deleted.has(item.id)).sort(newestFirst)

	return { v: PDF_SIGNATURES_VERSION, items: kept, deleted: tombstones }
}

// Reads a stored file; entries that are not this format are dropped. Throws PdfSignaturesVersionError for a newer
// format and SyntaxError for text that is not JSON.
export function parsePdfSignatures(text: string): PdfSignaturesDoc {
	const value: unknown = JSON.parse(text)

	if (typeof value !== "object" || value === null || Array.isArray(value)) return emptyPdfSignatures()

	const version: unknown = Reflect.get(value, "v")

	if (typeof version === "number" && version > PDF_SIGNATURES_VERSION) throw new PdfSignaturesVersionError(version)

	const rawItems: unknown = Reflect.get(value, "items")
	const rawDeleted: unknown = Reflect.get(value, "deleted")
	const items = new Map<string, SavedPdfSignature>()
	const deleted = new Map<string, number>()

	if (Array.isArray(rawItems)) {
		for (const raw of rawItems) {
			const parsed = entry(raw)

			if (!(parsed instanceof type.errors) && !items.has(parsed.id)) items.set(parsed.id, toSaved(parsed))
		}
	}

	if (typeof rawDeleted === "object" && rawDeleted !== null && !Array.isArray(rawDeleted)) {
		for (const [id, stamp] of Object.entries(rawDeleted)) {
			if (ID.test(id) && typeof stamp === "number" && Number.isFinite(stamp)) deleted.set(id, Math.trunc(stamp))
		}
	}

	return settle(items.values(), deleted)
}

// Stable text, so equal documents serialise identically.
export function serializePdfSignatures(doc: PdfSignaturesDoc): string {
	const deleted = [...doc.deleted].sort((a, b) => (a[0] < b[0] ? -1 : 1))

	return JSON.stringify({
		v: PDF_SIGNATURES_VERSION,
		items: doc.items.map(item => ({ id: item.id, role: item.role, at: item.at, ...item.data })),
		deleted: Object.fromEntries(deleted)
	})
}

export function mergePdfSignatures(a: PdfSignaturesDoc, b: PdfSignaturesDoc): PdfSignaturesDoc {
	const items = new Map<string, SavedPdfSignature>()
	const deleted = new Map(a.deleted)

	for (const [id, stamp] of b.deleted) deleted.set(id, Math.max(stamp, deleted.get(id) ?? Number.NEGATIVE_INFINITY))
	for (const item of [...a.items, ...b.items]) if (!items.has(item.id)) items.set(item.id, item)

	return settle(items.values(), deleted)
}

export function samePdfSignatures(a: PdfSignaturesDoc, b: PdfSignaturesDoc): boolean {
	return serializePdfSignatures(a) === serializePdfSignatures(b)
}

// Whether `data` is storable (the bounds parsing enforces), so a save never writes what a read would drop.
export function isStorablePdfSignature(data: SavedPdfSignatureData): boolean {
	return !(entry({ id: "x", role: "signature", at: 0, ...data }) instanceof type.errors)
}

// The document with `item` added (unchanged when its id is known or it is not storable); beyond
// PDF_SIGNATURES_MAX_PER_ROLE entries of its role, the oldest are deleted.
export function addPdfSignature(doc: PdfSignaturesDoc, item: SavedPdfSignature): PdfSignaturesDoc {
	if (doc.deleted.has(item.id) || doc.items.some(other => other.id === item.id) || !isStorablePdfSignature(item.data)) return doc

	const items = [item, ...doc.items].sort(newestFirst)
	const deleted = new Map(doc.deleted)
	const sameRole = items.filter(other => other.role === item.role)

	for (const old of sameRole.slice(PDF_SIGNATURES_MAX_PER_ROLE)) deleted.set(old.id, item.at)

	return settle(items, deleted)
}

export function deletePdfSignature(doc: PdfSignaturesDoc, id: string, stamp: number): PdfSignaturesDoc {
	if (!doc.items.some(item => item.id === id)) return doc

	const deleted = new Map(doc.deleted)

	deleted.set(id, Math.trunc(stamp))

	return settle(doc.items, deleted)
}
