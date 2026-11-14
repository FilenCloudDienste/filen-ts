import type { DriveItem } from "@/features/drive/lib/item"
import { SaveRefusedError, type PresentationSaveEdits } from "@/features/drive/lib/previewSave.logic"
import { writeEditedCopy } from "@/features/preview/lib/editedCopy"
import { recordOwnSave } from "@/features/preview/lib/ownSaves"
import { savePdfCopy, savePdfVersion, type PdfSaveDeps } from "@/features/pdf/save/pdfSave"
import { checkRemoteHead } from "@/features/pdf/save/remoteChange"
import { runOp } from "@/lib/actions/outcome"
import { sdkApi } from "@/lib/sdk/client"
import { log } from "@/lib/log"

// The editor's two saves as the viewer runs them: Save (a new version, through the preview overlay's port save) after
// a check that the file was not changed elsewhere since it opened (then: Save as copy, Save as new version anyway, or
// Cancel), and Save as copy (a new file beside it, the document staying unsaved).

export interface PdfSaveActionDeps extends PdfSaveDeps {
	readonly askRemote: () => Promise<"copy" | "version" | "cancel">
	// Words a copy's name: "report (edited).pdf", then "report (edited 2).pdf"...
	readonly copySuffix: (number: number) => string
	readonly onCopied: (name: string) => void
	readonly onCopyFailed: (error: unknown) => void
}

export interface PdfEditActions {
	saveVersion(): Promise<PresentationSaveEdits>
	saveCopy(): Promise<void>
}

// A refusal the overlay shows nothing for (the user chose another way, or cancelled).
function quietly(): SaveRefusedError {
	return new SaveRefusedError("previewPdfSaveFailed", { silent: true })
}

export function pdfEditActions(deps: () => PdfSaveActionDeps | null, item: DriveItem): PdfEditActions {
	const saveCopy = async (): Promise<void> => {
		const current = deps()

		if (current === null) return

		const written = await savePdfCopy(current, item, content => writeEditedCopy(item, content, "pdf", current.copySuffix)).catch(
			(error: unknown) => {
				log.warn("pdf", "saving a copy failed", { error })
				current.onCopyFailed(error)

				return undefined
			}
		)

		if (written === undefined) return

		if (written?.outcome.status !== "success") current.onCopyFailed(written?.outcome.status === "error" ? written.outcome.dto : null)
		else {
			// The copy is this tab's own: a listing that later shows it never announces it as made elsewhere.
			recordOwnSave(written.outcome.item.data.uuid)
			current.onCopied(written.name)
		}
	}

	return {
		saveCopy,
		saveVersion: async () => {
			const current = deps()

			if (current === null) throw new SaveRefusedError("previewPdfSaveFailed")

			const head = await checkRemoteHead(item, { getFileByStableUuid: stableUuid => runOp(sdkApi.getFileByStableUuid(stableUuid)) })

			if (head.kind === "changed") {
				const answer = await current.askRemote()

				if (answer === "copy") void saveCopy()
				if (answer !== "version") throw quietly()
			}

			return savePdfVersion(current, item)
		}
	}
}
