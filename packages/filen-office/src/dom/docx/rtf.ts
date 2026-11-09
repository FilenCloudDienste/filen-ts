import type { DocxGateReason } from "../../core/docx/package"
import type { ByteSource } from "../../core/opc/index"
import type { RtfLockedBlock } from "../../core/rtf/write/proof"
import type { DocxHost } from "./host"
import type { DocxAbortSignal } from "./protection"
import type { DocxConversion } from "./convert"
import type { DocxSaveNotice } from "./save"

export { rtfBlockProof } from "../../core/rtf/write/proof"

// RTF documents where the document engine runs (web: the docx worker): the file read once into the WordprocessingML
// package the viewer and the editor open (never on the page's thread: a large file takes tens of ms), held there
// with its source; Gate 1 proved there when the document is edited, and each save written back as RTF there
// (rtfWorker.ts). The page holds no copy of the package unless the editor takes one. OpenDocument text documents are
// held, proved and written the same way (the pool's `odt`), saved as ODT.

export type { RtfLockedBlock }

// Why a save was refused (the RTF or ODT writer's reason and message), carried over the worker boundary.
export class DocxRtfRefusal extends Error {
	readonly reason: string

	constructor(reason: string, message: string) {
		super(message)
		this.name = "DocxRtfRefusal"
		this.reason = reason
	}
}

// A written file, and what its writer wrote otherwise than the edit has it (an ODF 1.1 file's comments as points).
export interface DocxRtfSaved {
	readonly bytes: Uint8Array
	readonly notices?: readonly DocxSaveNotice[]
}

export interface DocxRtfEdits {
	// Parts the docx writer wrote (replaced and added), by name.
	readonly parts: readonly (readonly [string, Uint8Array])[]
	readonly removed: readonly string[]
}

export interface DocxRtfDocument {
	// The viewer's source: { host, bytes }. The host opens the package where it is held; `bytes` gives its size only.
	readonly host: DocxHost
	readonly bytes: ByteSource
	// What the file shows that the package's pages leave out (an RTF's drawing objects, shapes drawn by no picture,
	// text or preset geometry, objects without their result...), counted: a PDF of the package reports it (DocxPdfExportOptions.untranslated).
	readonly untranslated: number
	// What makes the document view-only that the package does not say (a signed ODT): the editor opens it with
	// these reasons (DocxEditingOptions.gate), so it is saved only as a new file.
	readonly gate: readonly DocxGateReason[]
	// A copy of the package, for the editor.
	take(): Promise<Uint8Array>
	// Gate 1 (once, when the document is to be edited): the top-level blocks the RTF writer cannot write.
	prove(): Promise<readonly RtfLockedBlock[]>
	// The RTF of the document as edited; rejects with a DocxRtfRefusal for an edit it cannot write.
	write(edits: DocxRtfEdits): Promise<DocxRtfSaved>
	// The document as edited converted to .docx where it is held (its package with the docx writer's parts, never
	// through its own writer, so an edit that writer refuses still converts). The signal ends the job.
	convertEdited(edits: DocxRtfEdits, options?: { readonly signal?: DocxAbortSignal }): Promise<DocxConversion>
	// Drops what is held; call once every session on it closed.
	release(): void
}

export type DocxRtfOpen =
	{ readonly kind: "opened"; readonly document: DocxRtfDocument } | { readonly kind: "notRtf" } | { readonly kind: "aborted" }

export interface DocxRtf {
	open(bytes: Uint8Array, options?: { readonly signal?: DocxAbortSignal }): Promise<DocxRtfOpen>
}
