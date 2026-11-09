import { DocxSaveError, prepareDocxSave, writerProof, type DocxPreparedSave } from "@filen/office/core/docx/write"
import { joinBytes } from "@filen/office/core/opc"
import type { DocxLaterProof } from "@filen/office/dom/docx/editing"
import { DocxRtfRefusal, rtfBlockProof, type DocxRtfDocument, type DocxRtfSaved, type RtfLockedBlock } from "@filen/office/dom/docx/rtf"
import type { DocxZipper } from "@filen/office/dom/docx/save"
import type { DocxEditingBackend } from "@/features/preview/lib/docxEditing"
import type { PreviewKey } from "@/lib/i18n"

// A refusal of what the file's format cannot hold at all, whichever blocks are taken back (a reply to a comment or
// a resolved comment in RTF, whose annotations have neither): the toast says what to change.
export class FormatSaveError extends DocxSaveError {
	readonly messageKey: PreviewKey

	constructor(messageKey: PreviewKey, message: string) {
		super("write", message)
		this.name = "FormatSaveError"
		this.messageKey = messageKey
	}
}

// RTF and OpenDocument text documents in the docx editor: edited as the package they read as (taken from the docx
// worker, which holds it with the file), saved by writing the parts the docx writer wrote back into the file's own
// format there (the lossless RTF and ODT writers: untouched blocks keep their bytes; each reads its result back and
// refuses an edit it cannot write).

// The parts a save writes, as the RTF writer takes them (pieces joined: copies, handed to the worker).
async function rtfEdits(prepared: DocxPreparedSave): Promise<{ parts: [string, Uint8Array][]; removed: string[] }> {
	const parts: [string, Uint8Array][] = []

	for (const change of [...prepared.replace, ...prepared.add]) {
		parts.push([change.name, await joinBytes(change.bytes)])
	}

	return { parts, removed: [...(prepared.remove ?? [])] }
}

// What makes the editor write RTF (or ODT): Gate 1 is the docx writer's proof, checked while the RTF writer's (`locked`) is
// proved in the worker, then both (editing starts once they are known: no edit precedes a lock); a save is the docx
// writer's parts written as RTF. The RTF is written as part of prepare (so the search for blocks the writer
// refuses includes the RTF writer's refusals) and handed out by the zipper.
export function rtfEditingBackend(
	document: DocxRtfDocument,
	locked: Promise<readonly RtfLockedBlock[]>,
	format: "RTF" | "ODT" = "RTF"
): DocxEditingBackend {
	const written = new WeakMap<DocxPreparedSave, DocxRtfSaved>()
	const write = async (prepared: DocxPreparedSave): Promise<DocxRtfSaved> => {
		try {
			return await document.write(await rtfEdits(prepared))
		} catch (error) {
			if (error instanceof DocxRtfRefusal) {
				if (error.reason === "comment") {
					throw new FormatSaveError("previewDocxSaveRefusedRtfComments", `${format}: ${error.message}`)
				}

				throw new DocxSaveError("write", `${format}: ${error.message}`)
			}

			throw error
		}
	}
	const zipper = (): DocxZipper => ({
		async zip(prepared) {
			const started = performance.now()
			const { bytes, notices } = written.get(prepared as DocxPreparedSave) ?? (await write(prepared as DocxPreparedSave))

			return {
				bytes,
				changedParts: [],
				zipMs: performance.now() - started,
				verifyZipMs: 0,
				...(notices === undefined || notices.length === 0 ? {} : { notices })
			}
		},
		dispose() {
			// The document is released by its viewer (rtfDocument.tsx).
		}
	})

	return {
		untranslated: document.untranslated,
		gate: document.gate,
		// Converts to .docx as edited where the document is held (its package with the docx writer's parts), never
		// through its own writer.
		convertEdited: async (prepared: DocxPreparedSave, signal: AbortSignal) =>
			document.convertEdited(await rtfEdits(prepared), { signal }),
		proof: (context): DocxLaterProof => {
			const docx = writerProof(context)

			const later = locked.then(blocks => ({ extra: rtfBlockProof(blocks), full: rtfBlockProof(blocks, docx) }))

			// Awaited only by an open that gets that far (one closed first leaves it; its failure shows in rtfDocument.tsx).
			void later.catch(() => undefined)

			return { first: docx, later }
		},
		writer: {
			async prepare(input, options) {
				const prepared = await prepareDocxSave(input, options)

				written.set(prepared, await write(prepared))

				return prepared
			},
			zipper
		}
	}
}
