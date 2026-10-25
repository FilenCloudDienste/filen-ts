import { useTranslation } from "react-i18next"
import { ChevronDownIcon, FileIcon } from "lucide-react"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { EditorDownloadAsItems, type LiveFile } from "@/features/drive/components/editorDownloadAs"

export interface DocxFileMenuProps {
	// Offers Download as ▸ PDF; undefined when the file may not be downloaded.
	onDownloadPdf: (() => void) | undefined
	// Download as ▸ another format from the editor's document as it holds it (unsaved edits included); undefined:
	// from the saved file.
	liveFile?: LiveFile | undefined
	// The editor's File tab, first in its ribbon (the viewer's is an icon in its toolbar).
	ribbon?: boolean
	// Offers the autosave setting (the editor's).
	autosave?: { checked: boolean; onChange: (autosave: boolean) => void } | undefined
}

// The Word document's file actions: Download as ▸ PDF, then the formats the document converts to, and the editor's
// autosave setting. Nothing to offer: not shown.
export function DocxFileMenu({ onDownloadPdf, liveFile, ribbon, autosave }: DocxFileMenuProps) {
	const { t } = useTranslation("preview")

	if (onDownloadPdf === undefined && autosave === undefined) {
		return null
	}

	return (
		<DropdownMenu>
			{ribbon === true ? (
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
			) : (
				<Tooltip>
					<TooltipTrigger
						render={
							<DropdownMenuTrigger
								render={
									<Button
										variant="ghost"
										size="icon-xs"
										aria-label={t("previewDocxFileMenu")}
										className="shrink-0"
									>
										<FileIcon />
									</Button>
								}
							/>
						}
					/>
					<TooltipContent>{t("previewDocxFileMenu")}</TooltipContent>
				</Tooltip>
			)}
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
