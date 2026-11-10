import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { DownloadIcon, SaveIcon } from "lucide-react"
import type { Format } from "@filen/office/core/presentation"
import type { PresentationSessionApi } from "@filen/office/dom/presentation"
import { DropdownMenuCheckboxItem, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import type { DriveItem } from "@/features/drive/lib/item"
import type { LegacySaveCopy } from "@/features/presentation/components/legacyView"
import { saveOfficeAutosave, useOfficeSettings } from "@/features/office/lib/officeSettings"
import { usePresentationEditor, type PresentationTextFlush } from "@/features/presentation/hooks/usePresentationSession"
import { usePreviewDownload } from "@/features/preview/lib/accessMode"
import { MenuKbd } from "@/lib/keymap/kbdHints"
import { useIsOnline } from "@/lib/useIsOnline"

// What the presentation File menu's entry files are given (the menu, presentationFileMenu.tsx, lists them in order).
export interface PresentationFileMenuContext {
	readonly editable: boolean
	// Downloads are allowed (not a downloads-disabled link).
	readonly downloads: boolean
	readonly close: () => void
	// The file the deck was opened from, its format, and its open session (exports and conversions read the session,
	// so they include unsaved changes).
	readonly item?: DriveItem
	readonly format?: Format
	readonly session?: PresentationSessionApi
	// Where a copy may be saved beside the file (a drive file the user may write beside), and where it opens.
	readonly saveCopy?: LegacySaveCopy
	// The body being typed in: sent to the deck before a conversion reads it (as Save sends it).
	readonly text?: Pick<PresentationTextFlush, "flush">
}

export interface PresentationFileMenuEntryProps {
	readonly context: PresentationFileMenuContext
}

// Save (the overlay's save, preview.save's keys) and Download (the file as the drive has it).
export function PresentationSaveEntries({ context }: PresentationFileMenuEntryProps): ReactNode {
	const { t } = useTranslation("preview")
	const scope = usePresentationEditor()
	const download = usePreviewDownload()
	const editor = scope?.editor
	const save = scope?.view.save

	if (editor === undefined && (download === null || !context.downloads)) return null

	return (
		<>
			{editor === undefined || save === undefined || !context.editable ? null : (
				<DropdownMenuItem
					disabled={!editor.document.dirty || editor.saving}
					onClick={() => {
						save()
					}}
				>
					<SaveIcon />
					{t("previewPptxEditorSave")}
					<MenuKbd action="preview.save" />
				</DropdownMenuItem>
			)}
			{download === null || !context.downloads ? null : (
				<DropdownMenuItem onClick={download}>
					<DownloadIcon />
					{t("previewPptxEditorDownload")}
				</DropdownMenuItem>
			)}
		</>
	)
}

// The autosave setting (the same synced setting as Settings → Documents), and why this deck never autosaves when its
// size or encryption rules it out (lib/autosavePolicy.ts).
export function PresentationAutosaveEntry({ context }: PresentationFileMenuEntryProps): ReactNode {
	const { t } = useTranslation(["preview", "settings"])
	const scope = usePresentationEditor()
	const settings = useOfficeSettings()
	const online = useIsOnline()

	if (scope === undefined || !context.editable) return null

	const tier = scope.editor.autosave.tier
	const off = tier.kind === "off"

	return (
		<DropdownMenuCheckboxItem
			closeOnClick
			checked={!off && settings.autosave}
			disabled={off || !settings.loaded || !online}
			onCheckedChange={checked => {
				saveOfficeAutosave(checked).catch(() => {
					toast.error(t("settings:settingsDocumentsSaveFailed"))
				})
			}}
		>
			<span className="flex flex-col">
				{t("previewPptxEditorAutosave")}
				{off ? (
					<span className="text-xs text-muted-foreground">
						{t(tier.reason === "encrypted" ? "previewPptxEditorAutosaveOffEncrypted" : "previewPptxEditorAutosaveOffLarge")}
					</span>
				) : null}
			</span>
		</DropdownMenuCheckboxItem>
	)
}
