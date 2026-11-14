import { useTranslation } from "react-i18next"
import { CopyIcon, FileOutputIcon, RotateCcwIcon, RotateCwIcon, ScissorsIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { PdfInsertMenu, type PdfInsertMenuProps } from "@/features/pdf/pages/insertMenu"
import { actionPages } from "@/features/pdf/pages/organise.logic"
import { PdfPagesRail, type PdfPagesRailProps } from "@/features/pdf/pages/pagesRail"

export interface PdfOrganiseGridProps extends Omit<PdfPagesRailProps, "layout" | "className"> {
	readonly insert: Omit<PdfInsertMenuProps, "disabled">
	readonly onDuplicate: (pages: number[]) => void
	readonly onExtract: () => void
	readonly onSplit: () => void
	readonly onClose: () => void
	// Why the page tools are off (a signed or restricted PDF, offline); undefined when they are on.
	readonly disabledReason?: string
}

// The full Organise view of the Pages tab: a toolbar (Insert ▾, Extract, Split, rotate, delete, duplicate, the
// selection's size, Done) over every page as a grid, multi-select, drag and Alt+arrows to move, hover actions and the
// live region's sentence. Values in, callbacks out; the host runs the commands.
export function PdfOrganiseGrid({ insert, onDuplicate, onExtract, onSplit, onClose, disabledReason, ...rail }: PdfOrganiseGridProps) {
	const { t } = useTranslation("preview")
	const pages = (): number[] => actionPages(rail.selected, rail.current)
	const locked = disabledReason !== undefined || !rail.editable
	const count = Math.max(1, rail.selected.size)

	return (
		<section
			className="flex size-full min-h-0 flex-col bg-background"
			aria-label={t("previewPdfPagesOrganise")}
			data-preview-surface
		>
			<header className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
				<h2 className="mr-2 px-1 text-sm font-medium">{t("previewPdfPagesOrganise")}</h2>
				<div
					role="toolbar"
					aria-label={t("previewPdfPagesToolbarLabel")}
					className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5"
				>
					<PdfInsertMenu
						{...insert}
						disabled={locked}
					/>
					<Button
						variant="ghost"
						size="sm"
						onClick={onExtract}
					>
						<FileOutputIcon aria-hidden="true" />
						{t("previewPdfPagesExtract")}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={onSplit}
					>
						<ScissorsIcon aria-hidden="true" />
						{t("previewPdfPagesSplit")}
					</Button>
					<TooltipIconButton
						label={t("previewPdfPagesRotateCcw")}
						disabled={locked}
						title={disabledReason}
						onClick={() => {
							rail.onRotate(pages(), -90)
						}}
					>
						<RotateCcwIcon aria-hidden="true" />
					</TooltipIconButton>
					<TooltipIconButton
						label={t("previewPdfPagesRotateCw")}
						disabled={locked}
						title={disabledReason}
						onClick={() => {
							rail.onRotate(pages(), 90)
						}}
					>
						<RotateCwIcon aria-hidden="true" />
					</TooltipIconButton>
					<TooltipIconButton
						label={t("previewPdfPagesDuplicate")}
						disabled={locked}
						title={disabledReason}
						onClick={() => {
							onDuplicate(pages())
						}}
					>
						<CopyIcon aria-hidden="true" />
					</TooltipIconButton>
					<TooltipIconButton
						label={t("previewPdfPagesDelete")}
						disabled={locked || pages().length >= rail.pages.length}
						title={pages().length >= rail.pages.length ? t("previewPdfPagesLastPage") : disabledReason}
						onClick={() => {
							rail.onDelete(pages())
						}}
					>
						<Trash2Icon aria-hidden="true" />
					</TooltipIconButton>
					<span
						className="ml-2 text-xs text-muted-foreground"
						aria-live="off"
					>
						{t("previewPdfPagesSelected", { count })}
					</span>
				</div>
				<Button
					variant="outline"
					size="sm"
					onClick={onClose}
				>
					{t("previewPdfPagesOrganiseDone")}
				</Button>
			</header>
			<div className="min-h-0 flex-1">
				<PdfPagesRail
					{...rail}
					editable={rail.editable && !locked}
					layout="grid"
				/>
			</div>
		</section>
	)
}
