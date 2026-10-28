import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { driveItemName } from "@filen/shared"
import { FileTextIcon, ImageIcon, PrinterIcon } from "lucide-react"
import type { SlideRef } from "@filen/office/core/presentation"
import { DEFAULT_EXPORT_WIDTH, type PdfJobRequest } from "@filen/office/dom/presentation"
import type { PresentationDocument } from "@filen/office/react/presentation"
import {
	DropdownMenuCheckboxItem,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger
} from "@/components/ui/dropdown-menu"
import type { PresentationFileMenuEntryProps } from "@/features/presentation/components/fileMenu/save"
import { usePresentationImageExport } from "@/features/presentation/hooks/usePresentationImageExport"
import { usePresentationPdfExport } from "@/features/presentation/hooks/usePresentationPdfExport"
import { usePresentationEditor } from "@/features/presentation/hooks/usePresentationSession"
import { usePresentationPrint } from "@/features/presentation/print/usePresentationPrint"

// Export as PDF (slides, notes pages, handouts of 1, 2, 3, 4, 6 or 9), Export as images (the current slide, or all as a
// .zip, at a chosen width) and Print. Each reads the open deck as it is now, unsaved edits included. None is offered
// where the file may not be downloaded (a link that disallows downloads): a print or an export is a copy of the file.

type PerPage = NonNullable<PdfJobRequest["perPage"]>

const PER_PAGE: readonly PerPage[] = [1, 2, 3, 4, 6, 9]
const WIDTHS: readonly number[] = [1280, DEFAULT_EXPORT_WIDTH, 3840]

// The choices made in this tab, kept while the menu closes and opens again.
const remembered = { includeHidden: false, width: DEFAULT_EXPORT_WIDTH }

export interface PresentationExportItemsProps {
	readonly document: PresentationDocument | undefined
	readonly current: SlideRef | undefined
	readonly fileName: string
	// The host allows downloads (the File menu's context; the viewer's command bar shows these only where it does).
	readonly downloads: boolean
}

// The entries, for any File menu over an open deck (the editor's, the viewer's command bar).
export function PresentationExportItems({ document, current, fileName, downloads }: PresentationExportItemsProps): ReactNode {
	const { t } = useTranslation("preview")
	const [includeHidden, setIncludeHidden] = useState(remembered.includeHidden)
	const [width, setWidth] = useState(remembered.width)
	const session = document?.session
	const info = document?.info
	const target =
		session === undefined || info === undefined || !downloads ? null : { session, fileName, encrypted: info.protection.encrypted }
	const exportPdf = usePresentationPdfExport(target)
	const exportImages = usePresentationImageExport(target === null ? null : { ...target, current })
	const print = usePresentationPrint(downloads ? session : undefined, info)

	if (exportPdf === undefined && exportImages === undefined && print === undefined) return null

	const hidden = info?.slides.some(slide => slide.hidden) === true

	return (
		<>
			{exportPdf === undefined ? null : (
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						<FileTextIcon />
						{t("previewPptxExportPdf")}
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent data-preview-surface>
						<DropdownMenuItem
							onClick={() => {
								exportPdf({ layout: "slides", includeHidden })
							}}
						>
							{t("previewPptxExportPdfSlides")}
						</DropdownMenuItem>
						<DropdownMenuItem
							onClick={() => {
								exportPdf({ layout: "notes", includeHidden })
							}}
						>
							{t("previewPptxExportPdfNotes")}
						</DropdownMenuItem>
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>{t("previewPptxExportPdfHandouts")}</DropdownMenuSubTrigger>
							<DropdownMenuSubContent data-preview-surface>
								{PER_PAGE.map(perPage => (
									<DropdownMenuItem
										key={perPage}
										onClick={() => {
											exportPdf({ layout: "handouts", perPage, includeHidden })
										}}
									>
										{t("previewPptxExportPerPage", { count: perPage })}
									</DropdownMenuItem>
								))}
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						{hidden ? (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuCheckboxItem
									checked={includeHidden}
									onCheckedChange={checked => {
										remembered.includeHidden = checked
										setIncludeHidden(checked)
									}}
								>
									{t("previewPptxExportIncludeHidden")}
								</DropdownMenuCheckboxItem>
							</>
						) : null}
						{info?.protection.encrypted === true ? (
							// A label belongs to a group (the viewer's File menu puts none around these entries).
							<DropdownMenuGroup>
								<DropdownMenuLabel className="max-w-56 text-xs font-normal text-muted-foreground">
									{t("previewPptxExportProtected")}
								</DropdownMenuLabel>
							</DropdownMenuGroup>
						) : null}
					</DropdownMenuSubContent>
				</DropdownMenuSub>
			)}
			{exportImages === undefined ? null : (
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>
						<ImageIcon />
						{t("previewPptxExportImages")}
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent data-preview-surface>
						{(["png", "jpeg"] as const).map(format => (
							<DropdownMenuItem
								key={`current-${format}`}
								disabled={current === undefined}
								onClick={() => {
									exportImages({ format, widthPx: width, scope: "current" })
								}}
							>
								{t("previewPptxExportImageCurrent", { format: format === "png" ? "PNG" : "JPEG" })}
							</DropdownMenuItem>
						))}
						{(["png", "jpeg"] as const).map(format => (
							<DropdownMenuItem
								key={`all-${format}`}
								onClick={() => {
									exportImages({ format, widthPx: width, scope: "all" })
								}}
							>
								{t("previewPptxExportImageAll", { format: format === "png" ? "PNG" : "JPEG" })}
							</DropdownMenuItem>
						))}
						<DropdownMenuSeparator />
						<DropdownMenuGroup>
							<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
								{t("previewPptxExportWidth")}
							</DropdownMenuLabel>
							<DropdownMenuRadioGroup
								value={String(width)}
								onValueChange={value => {
									const next = Number(value)

									remembered.width = next
									setWidth(next)
								}}
							>
								{WIDTHS.map(option => (
									<DropdownMenuRadioItem
										key={option}
										value={String(option)}
									>
										{t("previewPptxExportWidthOption", { width: option })}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuGroup>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
			)}
			{print === undefined ? null : (
				<DropdownMenuItem onClick={print}>
					<PrinterIcon />
					{t("previewPptxExportPrint")}
				</DropdownMenuItem>
			)}
		</>
	)
}

// The editor's File menu run.
export function PresentationExportEntries({ context }: PresentationFileMenuEntryProps): ReactNode {
	const scope = usePresentationEditor()

	return (
		<PresentationExportItems
			document={scope?.editor.document}
			current={scope?.editor.currentRef}
			fileName={context.item === undefined ? "" : driveItemName(context.item)}
			downloads={context.downloads}
		/>
	)
}
