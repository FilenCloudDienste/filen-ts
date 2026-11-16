import { BLOCK_BYTES } from "@filen/shared/videos"
import type { FileVerdict, SniffId } from "@filen/shared"

// How each content read (@filen/shared's SniffId) runs. Pure, for the gates (preview.logic.ts); the reads themselves are
// contentSniff.ts's.

export type Sniffer =
	// Decided on the page from the file's first `headBytes` (at most one block).
	| { readonly mode: "head"; readonly headBytes: number; decide(head: Uint8Array, size: number): FileVerdict }
	// Decided by a probe the player opening on it reuses: a drive or link file's only.
	| { readonly mode: "probe" }
	// Decided by the read the fallback viewer makes anyway, which records the verdict itself.
	| { readonly mode: "viewer" }

export const SNIFFERS: Readonly<Record<SniffId, Sniffer>> = {
	// The container probe the video player's ladder reads next (transportStreamProbe.ts).
	transportStream: { mode: "probe" },
	// The docx viewer's legacy reader tells a Word 97–2003 template from a Graphviz or text file.
	wordTemplate: { mode: "viewer" },
	// The presentation viewer's head sniff tells a PowerPoint 97–2003 template from a gettext template.
	presentationTemplate: { mode: "viewer" }
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
