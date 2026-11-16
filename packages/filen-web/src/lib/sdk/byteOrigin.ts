import type { AnyFile, ArchiveEntryId } from "@filen/sdk-rs"

// Where a preview's bytes come from, for every viewer and parser. Safe in workers: no DOM, no React.

// How an archive entry's bytes can be reached: by offset in the archive (`mapped`), through a decoder that can seek
// (`seekable`), only by decoding the entry whole (`whole`), or only by decoding what comes before it (`sequential`).
export type EntryAccessKind = "mapped" | "seekable" | "whole" | "sequential"

export type ByteOrigin =
	// A drive file, read through the session client.
	| { readonly kind: "file"; readonly file: AnyFile }
	// A public link's file, read through an unauthenticated client.
	| { readonly kind: "linkedFile"; readonly file: AnyFile }
	// An archive entry, read through the reader `reader` (a registry id in the SDK worker). `anon`: the reader was
	// opened on a public link's file, so only the unauthenticated client may read through it.
	| {
			readonly kind: "entry"
			readonly reader: string
			readonly entry: ArchiveEntryId
			readonly size: number
			readonly access: EntryAccessKind
			readonly anon: boolean
			readonly cacheKey: string
	  }
	// Bytes the page already holds (an attachment, an embedded part). Built only through bytesOrigin.
	| { readonly kind: "bytes"; readonly blob: Blob; readonly cacheKey: string }

export function originSize(o: ByteOrigin): number {
	switch (o.kind) {
		case "file":
		case "linkedFile":
			return Number(o.file.size)
		case "entry":
			return o.size
		case "bytes":
			return o.blob.size
	}
}

// Read by ranges through the SDK. Exactly one of originRanged / originWhole holds for every origin.
export function originRanged(o: ByteOrigin): boolean {
	switch (o.kind) {
		case "file":
		case "linkedFile":
			return true
		case "entry":
			return o.access === "mapped" || o.access === "seekable"
		case "bytes":
			return false
	}
}

// Read or handed over as a whole.
export function originWhole(o: ByteOrigin): boolean {
	return !originRanged(o)
}

// The preview cache's key: the file's uuid (which rotates with its content), else the origin's own key.
export function originKey(o: ByteOrigin): string {
	switch (o.kind) {
		case "file":
		case "linkedFile":
			return o.file.uuid
		case "entry":
		case "bytes":
			return o.cacheKey
	}
}

// Reachable without a session: what a public link's preview may resolve to.
export function originAnonSafe(o: ByteOrigin): boolean {
	switch (o.kind) {
		case "file":
			return false
		case "linkedFile":
		case "bytes":
			return true
		case "entry":
			return o.anon
	}
}

// The only constructor of the `bytes` kind. The holder wraps a Uint8Array once (`new Blob([bytes])`) and drops every
// reference to the array in the same tick. `cacheKey` is `${parentOriginKey}/${partId}`.
export function bytesOrigin(blob: Blob, cacheKey: string): ByteOrigin {
	return { kind: "bytes", blob, cacheKey }
}
