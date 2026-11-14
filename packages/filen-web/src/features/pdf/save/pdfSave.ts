import { savePortAnnounced } from "@filen/shared/savePort"
import type { PdfMemoryProfile } from "@filen/office/core/pdfedit"
import { createSyncRangeBuffer, type PdfAfterSave, type PdfSaveBegun, type PdfSaveEnded } from "@filen/office/dom/pdfedit"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import type { SaveResult } from "@filen/office/dom/presentation"
import { BLOCK_BYTES } from "@filen/shared/videos"
import type { DriveItem } from "@/features/drive/lib/item"
import { editedSaveTimes, SaveRefusedError, type PresentationSaveEdits } from "@/features/drive/lib/previewSave.logic"
import type { PdfEngine } from "@/features/pdf/session/engineWorker"
import type { ActionOutcome } from "@/lib/actions/outcome"
import type { PreviewKey } from "@/lib/i18n"
import { log } from "@/lib/log"

// A PDF save from the page's side. The engine writes the document into its heap (planned first: incremental only for
// a signed document whose signers allowed every change, else a full rewrite; refused over the memory budget), a second
// short-lived engine checks the written file by reading it from that heap (pages, revisions, encryption), and only then
// do its bytes stream to the upload, over a save port with their exact size. The engine holds the written file until
// the save ends: as a new version (the session goes on, its history kept; or on the written file opened in place where
// the old version will not stay readable; or in a fresh engine when the heap grew past its threshold), as a copy, or
// not at all (nothing changes). An interrupted upload never counts as saved.

// A written file opened in place on the engine's heap only up to this size; a larger one is read again from the drive.
export const PDF_ADOPT_MAX_BYTES = 64 * 1024 * 1024

export interface PdfSaveDeps {
	readonly engine: PdfEngine
	readonly session: PdfEditSessionModel
	readonly memory: PdfMemoryProfile
	// The password the document was opened with (the verifying engine opens the written file with it).
	readonly password: string | undefined
	// Opens a verifying engine on a channel (engineWorker openPdfEngineOnChannel).
	readonly openVerifier: (
		channel: { buffer: SharedArrayBuffer; port: MessagePort; length: number },
		password: string | undefined
	) => Promise<PdfEngine>
	// The account keeps earlier versions (an old version stays readable after a save); undefined when not known.
	readonly versioning: () => boolean | undefined
	// After a new version: the heap is past its threshold, so the session moves to a fresh engine on `saved`.
	readonly needsRespawn: (heapBytes: number) => boolean
	readonly respawn: (saved: DriveItem) => Promise<void>
	// The history started again (the user is told).
	readonly onHistoryReset: () => void
}

function refusalKey(reason: Extract<PdfSaveBegun, { status: "refused" }>["reason"]): PreviewKey {
	switch (reason) {
		case "overBudget":
			return "previewPdfOverBudget"
		case "poisoned":
			return "previewPdfPoisoned"
		case "invalidatesSignatures":
			return "previewPdfToolSigned"
	}
}

// Writes the document into the engine's heap and has a second engine check it. Throws SaveRefusedError (the save
// ended, nothing was uploaded) when it was refused or failed the check.
async function writeAndCheck(deps: PdfSaveDeps, inputBytes: number): Promise<Extract<PdfSaveBegun, { status: "written" }>> {
	const { client } = deps.engine
	const state = deps.session.getSnapshot().state
	const begun = await client.call("saveBegin", { inputBytes, memory: deps.memory, invalidateConfirmed: false })

	if (begun.status === "refused") throw new SaveRefusedError(refusalKey(begun.reason))

	const buffer = createSyncRangeBuffer(8, BLOCK_BYTES)
	const channel = new MessageChannel()
	const check = await client
		.call("serveOutput", { buffer, port: channel.port1 }, [channel.port1])
		.then(() => deps.openVerifier({ buffer, port: channel.port2, length: begun.size }, deps.password))
		.then(async verifier => {
			const result = await verifier.client.call("checkSaved", {
				pageCount: state.pageCount,
				versions: begun.versions,
				encryption: state.encryption.method
			})

			void verifier.close()

			return result
		})
		.catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }))

	if (!check.ok) {
		log.warn("pdf", "the written file failed its check", { reason: check.reason })
		await end(deps, "failed", "continue")

		throw new SaveRefusedError("previewPdfSaveVerifyFailed")
	}

	return begun
}

async function end(deps: PdfSaveDeps, outcome: "saved" | "copied" | "failed", next: PdfAfterSave): Promise<PdfSaveEnded> {
	const ended = await deps.engine.client.call("saveEnd", { outcome, next })

	deps.session.saved(ended)

	return ended
}

// Streams the held file to an upload over a new channel; resolves whether the upload made the file. `port` is the
// upload's end.
function stream(deps: PdfSaveDeps): {
	readonly port: MessagePort
	readonly announced: Promise<boolean>
	readonly uploaded: Promise<boolean>
} {
	const channel = new MessageChannel()
	const announced = savePortAnnounced(channel.port2)
	const uploaded = deps.engine.client.call("writeOutput", { port: channel.port1 }, [channel.port1]).then(
		written => written.uploaded,
		() => false
	)

	return { port: channel.port2, announced, uploaded }
}

// Save: a new version of `item`, for the preview overlay's port save (PresentationSaveEdits, with the exact size and the
// edited file's times).
export async function savePdfVersion(deps: PdfSaveDeps, item: DriveItem): Promise<PresentationSaveEdits> {
	const begun = await writeAndCheck(deps, Number(item.data.size))
	const upload = stream(deps)
	const result: Promise<SaveResult> = upload.uploaded.then(async uploaded => {
		if (uploaded) return { kind: "written", bytes: begun.size, revision: 0, notices: [] }

		await end(deps, "failed", "continue").catch(() => undefined)

		return { kind: "refused", reason: "failed" }
	})

	return {
		kind: "port",
		port: upload.port,
		announced: upload.announced,
		result,
		size: begun.size,
		times: editedSaveTimes(item, Date.now()),
		commit: async saved => {
			// Without earlier versions the file just replaced may go: the session moves onto the written one.
			const keepsOld = deps.versioning() !== false
			const next: PdfAfterSave = keepsOld || begun.size > PDF_ADOPT_MAX_BYTES ? "continue" : "adopt"
			const ended = await end(deps, "saved", next)

			if ((!keepsOld && next === "continue") || deps.needsRespawn(ended.heapBytes)) {
				await deps.respawn(saved)
				deps.onHistoryReset()
			} else if (ended.history === "reset") deps.onHistoryReset()

			return { dirty: deps.session.getSnapshot().state.dirty }
		}
	}
}

// Save as copy: the edited document as a new file beside `item` (the document itself stays unsaved). `write` uploads
// the stream as the copy (editedCopy.ts writeEditedCopy).
export async function savePdfCopy(
	deps: PdfSaveDeps,
	item: DriveItem,
	write: (content: {
		readonly port: MessagePort
		readonly size: number
	}) => Promise<{ outcome: ActionOutcome<DriveItem>; name: string } | null>
): Promise<{ outcome: ActionOutcome<DriveItem>; name: string } | null> {
	const begun = await writeAndCheck(deps, Number(item.data.size))
	const upload = stream(deps)
	const [written, uploaded] = await Promise.all([
		upload.announced.then(() => write({ port: upload.port, size: begun.size })),
		upload.uploaded
	])
	const made = uploaded && written?.outcome.status === "success"

	await end(deps, made ? "copied" : "failed", "continue")

	return written
}
