import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { ChevronDownIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { saveOfficeAutosave, useOfficeSettings } from "@/features/office/lib/officeSettings"
import { EditorDownloadAsItems, type LiveConversion } from "@/features/drive/components/editorDownloadAs"
import { useIsOnline } from "@/lib/useIsOnline"

export interface SheetFileMenuProps {
	// A text file (its CSV is its cells) rather than a workbook (its CSV is the sheet on show).
	text: boolean
	// Offers Download as ▸ CSV (never for a password-protected workbook, whose cells stay sealed, nor a file that may
	// not be downloaded).
	onDownloadCsv: (() => void) | undefined
	// Offers Download as ▸ PDF (the sheet on show as it prints); undefined when the file may not be downloaded.
	onDownloadPdf?: (() => void) | undefined
	// Offers Save as .xlsx (asks first).
	onSaveAsXlsx: (() => void) | undefined
	// Offers the autosave setting: the file is edited here.
	autosave: boolean
	// Offers Print… (opens the print dialog).
	onPrint?: (() => void) | undefined
	// Download as ▸ .xlsx / .ods from the open session (unsaved edits included); undefined: from the saved file.
	liveConversion?: LiveConversion | undefined
}

// The spreadsheet's file actions, first in its ribbon: Save as .xlsx, Download as ▸ PDF, CSV or the formats the
// workbook converts to, Print, and the autosave setting (the same synced setting as Settings → Advanced → Documents). Nothing to offer: not shown.
export function SheetFileMenu({ text, onDownloadCsv, onDownloadPdf, onSaveAsXlsx, autosave, onPrint, liveConversion }: SheetFileMenuProps) {
	const { t } = useTranslation(["preview", "settings"])
	const settings = useOfficeSettings()
	const online = useIsOnline()

	const downloads = onDownloadCsv !== undefined || onDownloadPdf !== undefined

	if (!downloads && onSaveAsXlsx === undefined && onPrint === undefined && !autosave) {
		return null
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="sm"
						aria-label={t("previewSheetFileMenu")}
						data-ribbon-file
						className="shrink-0 gap-0.5 px-2.5"
					>
						{t("previewSheetFileMenu")}
						<ChevronDownIcon className="size-3" />
					</Button>
				}
			/>
			<DropdownMenuContent
				align="start"
				data-preview-surface
			>
				{onSaveAsXlsx === undefined ? null : (
					<DropdownMenuItem onClick={onSaveAsXlsx}>{t("previewSpreadsheetSaveAsXlsx")}</DropdownMenuItem>
				)}
				{downloads ? (
					<DropdownMenuSub>
						<DropdownMenuSubTrigger>{t("previewSheetDownloadAs")}</DropdownMenuSubTrigger>
						<DropdownMenuSubContent data-preview-surface>
							{onDownloadPdf === undefined ? null : (
								<DropdownMenuItem onClick={onDownloadPdf}>{t("previewSheetDownloadPdf")}</DropdownMenuItem>
							)}
							{onDownloadCsv === undefined ? null : (
								<DropdownMenuItem onClick={onDownloadCsv}>
									{t(text ? "previewSheetDownloadCsvFormat" : "previewSheetDownloadSheetCsvFormat")}
								</DropdownMenuItem>
							)}
							<EditorDownloadAsItems live={liveConversion} />
						</DropdownMenuSubContent>
					</DropdownMenuSub>
				) : null}
				{onPrint === undefined ? null : <DropdownMenuItem onClick={onPrint}>{t("previewSheetPrintMenu")}</DropdownMenuItem>}
				{autosave ? (
					<>
						{onSaveAsXlsx === undefined && !downloads && onPrint === undefined ? null : <DropdownMenuSeparator />}
						<DropdownMenuCheckboxItem
							closeOnClick
							checked={settings.autosave}
							disabled={!settings.loaded || !online}
							onCheckedChange={checked => {
								saveOfficeAutosave(checked).catch(() => {
									toast.error(t("settings:settingsDocumentsSaveFailed"))
								})
							}}
						>
							{t("previewSheetAutosave")}
						</DropdownMenuCheckboxItem>
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
