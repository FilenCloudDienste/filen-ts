import { BLOCK_BYTES } from "@filen/shared/videos"
import type { FileVerdict, SniffId } from "@filen/shared"
import { SQLITE_HEADER, isSqliteHeader } from "@/features/preview/lib/sqliteBrowse.logic"

// How each content read (@filen/shared's SniffId) runs. Pure, for the gates (preview.logic.ts); the reads themselves are
// contentSniff.ts's.

export type Sniffer =
	// Decided on the page from the file's first `headBytes` (at most one block).
	| { readonly mode: "head"; readonly headBytes: number; decide(head: Uint8Array, size: number): FileVerdict }
	// Decided by a probe the player opening on it reuses: a drive or link file's only.
	| { readonly mode: "probe" }
	// Decided by the read the fallback viewer makes anyway, which records the verdict itself.
	| { readonly mode: "viewer" }

// A dynamic or differencing Virtual Hard Disk begins with a copy of its footer, whose cookie is "conectix". A fixed
// disk carries the footer only at its end: above the text cap it is refused before any read, below it the text viewer
// finds it is not text.
const VHD_COOKIE = Uint8Array.from("conectix", char => char.charCodeAt(0))
const VHD_FOOTER_BYTES = 512

export function isVirtualDiskHead(head: Uint8Array): boolean {
	return head.length >= VHD_COOKIE.length && VHD_COOKIE.every((byte, index) => head[index] === byte)
}

// A Keynote package is a zip, whose first local file header begins "PK\x03\x04" (the SDK lists by the same magic).
const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04] as const

export function isZipHead(head: Uint8Array): boolean {
	return head.length >= ZIP_LOCAL_HEADER.length && ZIP_LOCAL_HEADER.every((byte, index) => head[index] === byte)
}

export const SNIFFERS: Readonly<Record<SniffId, Sniffer>> = {
	// The container probe the video player's ladder reads next (transportStreamProbe.ts).
	transportStream: { mode: "probe" },
	// The docx viewer's legacy reader tells a Word 97–2003 template from a Graphviz or text file.
	wordTemplate: { mode: "viewer" },
	// The presentation viewer's head sniff tells a PowerPoint 97–2003 template from a gettext template.
	presentationTemplate: { mode: "viewer" },
	virtualDisk: {
		mode: "head",
		headBytes: VHD_FOOTER_BYTES,
		decide: head => (isVirtualDiskHead(head) ? "virtualDisk" : "notVirtualDisk")
	},
	iworkPackage: {
		mode: "head",
		headBytes: ZIP_LOCAL_HEADER.length,
		decide: head => (isZipHead(head) ? "iworkPackage" : "notIworkPackage")
	},
	// The SQLite header's 16 bytes, read through the origin the database viewer then reads.
	sqlite: {
		mode: "head",
		headBytes: SQLITE_HEADER.length,
		decide: head => (isSqliteHeader(head) ? "sqlite" : "notSqlite")
	}
}

// A head sniffer reads no more than this.
export const MAX_SNIFF_HEAD_BYTES = BLOCK_BYTES

// The read a file with no extension, and no kind by its name or MIME type, gets before it settles as "other", for
// files up to `cap` bytes. None yet.
export interface ExtensionlessSniff {
	readonly id: SniffId
	readonly cap: bigint
}

export const EXTENSIONLESS_SNIFF: ExtensionlessSniff | null = null

// Where a file's bytes come from, as far as a sniffer cares.
export type SniffOriginKind = "file" | "linkedFile" | "entry" | "bytes"

// Whether the gate in front of the viewer runs `sniffer` on bytes from `origin`. A viewer-mode read runs in the viewer;
// a probe needs a drive or link file.
export function gateRunsSniffer(sniffer: Sniffer, origin: SniffOriginKind): boolean {
	switch (sniffer.mode) {
		case "head":
			return true
		case "probe":
			return origin === "file" || origin === "linkedFile"
		case "viewer":
			return false
	}
}
