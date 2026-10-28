// The synced Photos library, `.filen/photos/library.v1.json`: which directories the timeline reads. Written rarely,
// by any device.
//
// { "v": 1, "roots": { "<directory uuid>": { "ad": { "t": <stamp>, "d": "<writer>", "v": <ms added> }, "x"?: <tombstone> } } }
//
// Each root is a record of last-writer-wins registers (registerRecords.ts); removing one writes a tombstone, so a
// merge with a copy that still holds it never brings it back, while adding it again later outlives the tombstone.
// Records, registers and fields this version doesn't know are carried through.

import { DOT_FILEN_SUBDIRS } from "./dotFilen"
import {
	hasLiveRegister,
	mergeRecordMaps,
	mergeUnknownFields,
	parseRegisterRecord,
	serializeCanonical,
	setRegister,
	tombstoneRecord,
	type Hlc,
	type RegisterRecord,
	type Stamp,
	type ValueRegister
} from "./videos/registerRecords"

export const PHOTOS_DIR_NAME = DOT_FILEN_SUBDIRS.photos
export const PHOTOS_LIBRARY_FILE_NAME = "library.v1.json"
export const PHOTOS_LIBRARY_VERSION = 1

// ad: wall-clock ms the root was added (orders the roots); its presence is what makes the root live.
export interface PhotosRootRecord extends RegisterRecord {
	ad?: ValueRegister<unknown>
}

export interface PhotosLibraryDoc {
	v: typeof PHOTOS_LIBRARY_VERSION
	roots: Record<string, PhotosRootRecord>
	[key: string]: unknown
}

const DOC_FIELDS: ReadonlySet<string> = new Set(["v", "roots"])

// The file was written by a newer format: it must not be overwritten by this one.
export class PhotosLibraryVersionError extends Error {
	readonly version: unknown

	constructor(version: unknown) {
		super(`Unsupported photos library version ${String(version)}`)
		this.name = "PhotosLibraryVersionError"
		this.version = version
	}
}

export function emptyPhotosLibrary(): PhotosLibraryDoc {
	return {
		v: PHOTOS_LIBRARY_VERSION,
		roots: {}
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Reads a stored file; records that are not valid are dropped, and text that is JSON but not this format reads as
// empty. Throws PhotosLibraryVersionError for a newer format and SyntaxError for text that is not JSON.
export function parsePhotosLibrary(text: string): PhotosLibraryDoc {
	const value: unknown = JSON.parse(text)

	if (!isObject(value)) {
		return emptyPhotosLibrary()
	}

	const version = value["v"]

	if (typeof version === "number" && version > PHOTOS_LIBRARY_VERSION) {
		throw new PhotosLibraryVersionError(version)
	}

	if (version !== PHOTOS_LIBRARY_VERSION) {
		return emptyPhotosLibrary()
	}

	const roots: Record<string, PhotosRootRecord> = {}
	const rawRoots = value["roots"]

	if (isObject(rawRoots)) {
		for (const key in rawRoots) {
			const record = key === "__proto__" ? null : parseRegisterRecord(rawRoots[key])

			if (record !== null) {
				roots[key] = record
			}
		}
	}

	return {
		...value,
		v: PHOTOS_LIBRARY_VERSION,
		roots
	}
}

// Key-order independent, so equal documents serialize identically.
export function serializePhotosLibrary(doc: PhotosLibraryDoc): string {
	return serializeCanonical(doc)
}

// Register-wise merge; associative, commutative and idempotent.
export function mergePhotosLibrary(a: PhotosLibraryDoc, b: PhotosLibraryDoc): PhotosLibraryDoc {
	const roots = mergeRecordMaps({ local: a.roots, remote: b.roots })
	const fields = mergeUnknownFields({ local: a, remote: b, known: DOC_FIELDS })

	if (!roots.remoteContributed && !fields.remoteContributed) {
		return a
	}

	if (!roots.localContributed && !fields.localContributed) {
		return b
	}

	return {
		...fields.value,
		v: PHOTOS_LIBRARY_VERSION,
		roots: roots.value
	}
}

export function samePhotosLibrary(a: PhotosLibraryDoc, b: PhotosLibraryDoc): boolean {
	return a === b || serializePhotosLibrary(a) === serializePhotosLibrary(b)
}

// The newest stamp in the document, for the clock to observe after a read.
export function photosLibraryMaxStamp(doc: PhotosLibraryDoc): Hlc {
	let max = 0

	for (const key in doc.roots) {
		const record: RegisterRecord | undefined = doc.roots[key]

		for (const field in record) {
			const value = record[field]

			if (isObject(value) && typeof value["t"] === "number") {
				max = Math.max(max, value["t"])
			}
		}
	}

	return max
}

export interface ActivePhotosRoot {
	dirUuid: string
	added: number
}

// The roots that aren't removed, in the order they were added.
export function activePhotosRoots(doc: PhotosLibraryDoc): ActivePhotosRoot[] {
	const out: ActivePhotosRoot[] = []

	for (const dirUuid in doc.roots) {
		const added = doc.roots[dirUuid]?.ad

		if (added === undefined) {
			continue
		}

		out.push({
			dirUuid,
			added: typeof added.v === "number" ? added.v : 0
		})
	}

	return out.sort((a, b) => a.added - b.added || (a.dirUuid < b.dirUuid ? -1 : a.dirUuid > b.dirUuid ? 1 : 0))
}

// Whether the document ever held a root, removed ones included.
export function hasPhotosRootRecords(doc: PhotosLibraryDoc): boolean {
	return Object.keys(doc.roots).length > 0
}

// Adds a root, or brings a removed one back; unchanged when it is a root already.
export function withPhotosRoot({
	doc,
	dirUuid,
	stamp,
	now
}: {
	doc: PhotosLibraryDoc
	dirUuid: string
	stamp: Stamp
	now: number
}): PhotosLibraryDoc {
	const previous = doc.roots[dirUuid]

	if (previous?.ad !== undefined) {
		return doc
	}

	const added: ValueRegister<number> = {
		t: stamp.t,
		d: stamp.d,
		v: now
	}

	return {
		...doc,
		roots: {
			...doc.roots,
			[dirUuid]: setRegister({ rec: previous, key: "ad", register: added })
		}
	}
}

// Unchanged when it is no root.
export function withoutPhotosRoot({
	doc,
	dirUuid,
	stamp,
	at
}: {
	doc: PhotosLibraryDoc
	dirUuid: string
	stamp: Stamp
	at: number
}): PhotosLibraryDoc {
	const record = doc.roots[dirUuid]

	if (record === undefined || !hasLiveRegister(record)) {
		return doc
	}

	return {
		...doc,
		roots: {
			...doc.roots,
			[dirUuid]: tombstoneRecord({ rec: record, stamp, at })
		}
	}
}
