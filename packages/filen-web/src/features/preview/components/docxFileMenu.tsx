import { useTranslation } from "react-i18next"
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
import { EditorDownloadAsItems, type LiveFile } from "@/features/drive/components/editorDownloadAs"

export interface DocxFileMenuProps {
	// Offers Download as ▸ PDF; undefined when the file may not be downloaded.
	onDownloadPdf: (() => void) | undefined
	// Download as ▸ another format from the editor's document as it holds it (unsaved edits included); undefined:
	// from the saved file.
	liveFile?: LiveFile | undefined
	// Offers the autosave setting (the editor's).
	autosave?: { checked: boolean; onChange: (autosave: boolean) => void } | undefined
}

// The Word document's file actions: Download as ▸ PDF, then the formats the document converts to, and the editor's
// autosave setting. Nothing to offer: not shown.
// The button is the ribbon's or command bar's File, first in it.
export function DocxFileMenu({ onDownloadPdf, liveFile, autosave }: DocxFileMenuProps) {
	const { t } = useTranslation("preview")

	if (onDownloadPdf === undefined && autosave === undefined) {
		return null
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="sm"
						aria-label={t("previewDocxFileMenu")}
						data-ribbon-file
						className="shrink-0 gap-0.5 px-2.5"
					>
						{t("previewDocxFileMenu")}
						<ChevronDownIcon className="size-3" />
					</Button>
				}
			/>
			<DropdownMenuContent
				align="start"
				data-preview-surface
			>
				{onDownloadPdf === undefined ? null : (
					<DropdownMenuSub>
						<DropdownMenuSubTrigger>{t("previewDocxDownloadAs")}</DropdownMenuSubTrigger>
						<DropdownMenuSubContent>
							<DropdownMenuItem onClick={onDownloadPdf}>{t("previewDocxDownloadPdf")}</DropdownMenuItem>
							<EditorDownloadAsItems liveFile={liveFile} />
						</DropdownMenuSubContent>
					</DropdownMenuSub>
				)}
				{autosave === undefined ? null : (
					<>
						{onDownloadPdf === undefined ? null : <DropdownMenuSeparator />}
						<DropdownMenuCheckboxItem
							closeOnClick
							checked={autosave.checked}
							onCheckedChange={autosave.onChange}
						>
							{t("previewDocxAutosave")}
						</DropdownMenuCheckboxItem>
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}
