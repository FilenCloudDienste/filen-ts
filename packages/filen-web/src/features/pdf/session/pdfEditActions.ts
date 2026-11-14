import type { DriveItem } from "@/features/drive/lib/item"
import { SaveRefusedError, type PresentationSaveEdits } from "@/features/drive/lib/previewSave.logic"
import { writeEditedCopy } from "@/features/preview/lib/editedCopy"
import { recordOwnSave } from "@/features/preview/lib/ownSaves"
import { savePdfCopy, savePdfVersion, signPdfVersion, type PdfSaveDeps } from "@/features/pdf/save/pdfSave"
import type { PdfSignedSaveJob } from "@/features/pdf/signing/signDocument"
import { checkRemoteHead } from "@/features/pdf/save/remoteChange"
import type { PdfFormSaveChoice } from "@/features/pdf/forms/formSave"
import type { PdfToolSaveOutcome } from "@/features/pdf/tools/registry"
import { runOp } from "@/lib/actions/outcome"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"

// The editor's two saves as the viewer runs them: Save (a new version, through the preview overlay's port save) after
// a check that the file was not changed elsewhere since it opened (then: Save as copy, Save as new version anyway, or
// Cancel), and Save as copy (a new file beside it, the document staying unsaved). A tool may ask for the next Save
// (a save in place, or a signing save) and be told how it ended.

export interface PdfSaveActionDeps extends PdfSaveDeps {
	// Commits what was typed into form fields and not yet committed (each as its step), before anything else of a save.
	readonly commitDrafts: () => Promise<void>
	readonly askRemote: () => Promise<"copy" | "version" | "cancel">
	// Words a copy's name: "report (edited).pdf", then "report (edited 2).pdf"...
	readonly copySuffix: (number: number) => string
	// `copy`: the file written, when known (to open it).
	readonly onCopied: (name: string, copy: DriveItem | undefined) => void
	readonly onCopyFailed: (error: unknown) => void
	// Asked before either save (a form's XFA confirm and required-fields warning): it may become the other save, or
	// none.
	readonly beforeSave?: (requested: "version" | "copy") => Promise<PdfFormSaveChoice>
	// Starts the overlay's Save (a Save as copy turned into a Save).
	readonly requestVersionSave?: () => void
	// The save a tool asked for: taken by the next Save.
	readonly takeRequest: () => PdfSaveRequest | null
	// A Save no tool asked for failed: said here when the overlay says nothing of it (a silent refusal with a reason).
	readonly onVersionFailed?: (error: unknown) => void
}

export interface PdfSaveRequest {
	// What a signing save signs; null for a plain save in place.
	readonly job: PdfSignedSaveJob | null
	// A plain save a signing follows: the session goes on on the written file where it fits.
	readonly adopt?: boolean
	// Once: how the save ended.
	readonly settle: (outcome: PdfToolSaveOutcome) => void
}

// The save's edits, telling `request` how the save ended: refused before or after writing, or committed.
function settling(edits: PresentationSaveEdits, request: PdfSaveRequest | null): PresentationSaveEdits {
	if (request === null) return edits

	void edits.result.then(
		result => {
			if (result.kind !== "written") request.settle({ status: "failed", error: new SaveRefusedError("previewPdfSaveFailed") })
		},
		(error: unknown) => {
			request.settle({ status: "failed", error })
		}
	)

	return {
		...edits,
		commit: file =>
			edits.commit(file).then(
				committed => {
					request.settle({ status: "saved", name: null })

					return committed
				},
				(error: unknown) => {
					request.settle({ status: "failed", error })

					throw error
				}
			)
	}
}

export interface PdfEditActions {
	saveVersion(): Promise<PresentationSaveEdits>
	saveCopy(): Promise<void>
	// A copy named with `suffix`, for a tool that reports the outcome itself (no toasts here).
	saveCopyAs(suffix: (number: number) => string): Promise<PdfToolSaveOutcome>
}

// A refusal the overlay shows nothing for (the user chose another way, or cancelled).
function quietly(): SaveRefusedError {
	return new SaveRefusedError("previewPdfSaveFailed", { silent: true })
}

export function pdfEditActions(deps: () => PdfSaveActionDeps | null, item: DriveItem): PdfEditActions {
	const saveCopyAs = async (suffix: (number: number) => string): Promise<PdfToolSaveOutcome> => {
		const current = deps()

		if (current === null) return { status: "cancelled" }

		const written = await savePdfCopy(current, content => writeEditedCopy(item, content, "pdf", suffix)).catch((error: unknown) => {
			log.warn("pdf", "saving a copy failed", { error })

			return { error }
		})

		if (written !== null && "error" in written) return { status: "failed", error: written.error }
		if (written?.outcome.status !== "success")
			return { status: "failed", error: written?.outcome.status === "error" ? written.outcome.dto : null }

		// The copy is this tab's own: a listing that later shows it never announces it as made elsewhere.
		recordOwnSave(written.outcome.item.data.uuid)

		return { status: "saved", name: written.name, item: written.outcome.item }
	}

	// `asked`: beforeSave already ran for this save.
	const saveCopy = async (asked = false): Promise<void> => {
		const current = deps()

		if (current === null) return

		await current.commitDrafts()

		if (!asked && current.beforeSave !== undefined) {
			const choice = await current.beforeSave("copy")

			if (choice === "version") current.requestVersionSave?.()
			if (choice !== "copy") return
		}

		const outcome = await saveCopyAs(current.copySuffix)

		if (outcome.status === "saved") current.onCopied(outcome.name ?? "", outcome.item)
		else if (outcome.status === "failed") current.onCopyFailed(outcome.error)
	}

	// Save, as the overlay runs it: the form's checks (never for a signing save, whose signature must be the last
	// step), the remote-change question, then the save itself.
	const saving = async (current: PdfSaveActionDeps, request: PdfSaveRequest | null): Promise<PresentationSaveEdits> => {
		const job = request?.job ?? null

		// A save the user asked for only: one a tool asked for saves the steps it made as they are (a signature stays the
		// last step, a redaction the steps it undoes when the save does not happen); the drafts stay for a later save.
		if (request === null) await current.commitDrafts()

		if (job === null && current.beforeSave !== undefined) {
			const choice = await current.beforeSave("version")

			if (choice === "copy") void saveCopy(true)
			if (choice !== "version") throw quietly()
		}

		const head = await checkRemoteHead(item, { getFileByStableUuid: stableUuid => runOp(sdkApi.getFileByStableUuid(stableUuid)) })

		if (head.kind === "changed") {
			const answer = await current.askRemote()

			// A copy of a placed, unsigned signature is never written: signing only saves a version.
			if (answer === "copy" && job === null) void saveCopy(true)
			if (answer !== "version") throw quietly()
		}

		return job === null ? savePdfVersion(current, item, request?.adopt === true) : signPdfVersion(current, item, job)
	}

	return {
		saveCopy: () => saveCopy(),
		saveCopyAs,
		saveVersion: async () => {
			const current = deps()
			const request = current?.takeRequest() ?? null

			if (current === null) {
				request?.settle({ status: "cancelled" })

				throw new SaveRefusedError("previewPdfSaveFailed")
			}

			return saving(current, request).then(
				edits => settling(edits, request),
				(error: unknown) => {
					if (request === null) current.onVersionFailed?.(error)
					else request.settle({ status: "failed", error })

					throw error
				}
			)
		}
	}
}
