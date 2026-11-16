import { type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { driveItemName } from "@filen/shared"
import { layerKeyFor } from "@filen/office/core/sheet"
import { type DriveItem } from "@/features/drive/lib/item"
import { stableUuidOf } from "@/features/drive/store/useDriveClipboardStore"
import { PreviewErrorState, PreviewLoading, PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { DocxPasswordGate } from "@/features/preview/components/docxPasswordPrompt"
import { docxRefusalKey } from "@/features/preview/components/docxViewer.logic"
import { uploadXlsxCopy } from "@/features/spreadsheet/lib/saveAsXlsx"
import { SheetBody } from "@/features/spreadsheet/components/sheetBody"
import { DownloadAsItemProvider } from "@/features/drive/components/editorDownloadAs"
import { useSheetSession } from "@/features/spreadsheet/hooks/useSheetSession"
import { saveAsRefusalKey, type SpreadsheetSaveSource } from "@/features/spreadsheet/save/sheetSave.logic"
import { savesAsXlsx, sheetXlsxCopy } from "@/features/spreadsheet/save/sheetSaveAs"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { log } from "@/lib/log"

// The spreadsheet viewer's props.
export interface SheetViewerProps {
	item: DriveItem
	// Names the document across this user's own saves (which give the item a new uuid): the file stays open, with
	// its undo history, while it holds.
	documentKey: string
	alt: string
	editable?: boolean
	// Why a file the user could otherwise edit is read-only, for the note beside the cell contents.
	readOnlyReason?: "renamed"
	// Nothing will ever edit this file here (a public link).
	neverEditable?: boolean
	onDirtyChange?: (dirty: boolean) => void
	saveRef?: RefObject<SpreadsheetSaveSource | null>
	// Shows another file in this preview's place: the .xlsx an .xls was just saved as.
	onOpenFile?: (item: DriveItem) => void
	// A converted copy may be written beside this file (a CSV, TSV or .xls offers Save as .xlsx).
	canSaveCopy?: boolean
	// Idle autosave asks the overlay to save; true when a save started.
	onAutosave?: () => boolean
}

// A CSV, TSV or Excel file on the office engine: the file is read and edited in a sheet worker (dom/sheet), which
// keeps it, and the grid (react/sheet) shows the tiles in view. Editable in the drive once the session proves
// that saving keeps everything in the file; `saveRef` hands the overlay its bytes as edited.
// The workbook's File menu offers Download as for this file (editorDownloadAs.tsx).
export function SheetViewer(props: SheetViewerProps) {
	return (
		<DownloadAsItemProvider item={props.item}>
			<SheetViewerBody {...props} />
		</DownloadAsItemProvider>
	)
}

function SheetViewerBody({
	item,
	documentKey,
	alt,
	editable,
	readOnlyReason,
	neverEditable,
	onDirtyChange,
	saveRef,
	onOpenFile,
	canSaveCopy,
	onAutosave
}: SheetViewerProps) {
	const { t } = useTranslation("preview")
	const state = useSheetSession(item, documentKey)

	switch (state.status) {
		case "pending":
			return <PreviewLoading />
		case "error":
			return (
				<PreviewErrorState
					message={errorLabel(state.dto)}
					onRetry={state.retry}
				/>
			)
		case "unreadable":
			return (
				<div className="flex size-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
					{t("previewSpreadsheetUnreadable")}
				</div>
			)
		// A protected workbook is refused, or asked its password, in the words a Word document is.
		case "refused":
			return <PreviewUnsupportedState message={t(docxRefusalKey(state.reason))} />
		case "locked":
			return (
				<DocxPasswordGate
					title={t("previewDocxPasswordTitle")}
					body={t("previewDocxPasswordBody", { name: driveItemName(item) })}
					wrongMessage={t("previewDocxPasswordWrong")}
					label={t("previewDocxPasswordLabel")}
					submitLabel={t("previewDocxPasswordSubmit")}
					progressLabel={t("previewDocxPasswordUnlocking")}
					message={t("previewDocxNeedsPassword")}
					enterLabel={t("previewDocxEnterPassword")}
					verify={state.verify}
				/>
			)
		case "ready":
			return state.handle.info.sheets.length === 0 ? (
				<div className="flex size-full items-center justify-center text-sm text-muted-foreground">
					{t("previewSpreadsheetEmpty")}
				</div>
			) : (
				<SheetBody
					key={state.id}
					handle={state.handle}
					kind={state.kind}
					alt={alt}
					editable={editable === true}
					unnamed={state.unnamed}
					renamed={state.renamed}
					readOnlyReason={readOnlyReason}
					neverEditable={neverEditable === true}
					onDirtyChange={onDirtyChange}
					saveRef={saveRef}
					editAnyway={state.editAnyway}
					modifyLocked={state.modifyLocked}
					layerKey={layerKeyFor(stableUuidOf(item), documentKey)}
					onAutosave={onAutosave}
					encryptedFile={state.handle.info.encrypted === undefined ? undefined : state.bytes}
					onSaveAsXlsx={
						savesAsXlsx(state.kind) && canSaveCopy === true
							? async () => {
									const copy = await sheetXlsxCopy(state.handle, state.kind, driveItemName(item)).catch((e: unknown) => {
										log.error("spreadsheet", "making the .xlsx copy failed", e)

										return { ok: false, refusal: null } as const
									})

									if (!copy.ok) {
										toast.error(t(saveAsRefusalKey(copy.refusal)))

										return
									}

									const outcome = await uploadXlsxCopy(item, copy.bytes).catch((e: unknown) => {
										log.error("spreadsheet", "uploading the .xlsx copy failed", e)

										return { status: "error", dto: null } as const
									})

									if (outcome.status === "error") {
										toast.error(
											outcome.dto === null ? t("previewSpreadsheetSaveAsXlsxFailed") : errorLabel(outcome.dto)
										)

										return
									}

									toast.success(t("previewSpreadsheetSavedAsXlsx", { name: outcome.name }))
									onOpenFile?.(outcome.item)
								}
							: undefined
					}
				/>
			)
	}
}
