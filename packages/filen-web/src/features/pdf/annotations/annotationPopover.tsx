import { useState } from "react"
import { useTranslation } from "react-i18next"
import { DownloadIcon, MessageSquareIcon, Trash2Icon } from "lucide-react"
import { cn } from "@filen/shared"
import { hexToRgb, type PdfAnnotationInfo, type PdfRgb } from "@filen/office/core/pdfedit/annotations"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Slider } from "@/components/ui/slider"
import { DocxColorGrid } from "@/features/office/components/officeColorGrid"
import { keepFocus, STANDARD_SWATCHES } from "@/features/office/lib/officeControls"
import {
	clampWidth,
	colorKey,
	hasColor,
	hasStrokeWidth,
	opacityPercent,
	PDF_ANNOT_WIDTH_MAX,
	PDF_ANNOT_WIDTH_MIN,
	PDF_ANNOT_WIDTH_STEP
} from "@/features/pdf/annotations/annotationPopover.logic"

// The selected annotation's floating toolbar: the office colour grid, opacity, line width (stroked types), its comment
// thread and delete. Values in, changes out: a slider commits once when released (one journal operation), a colour
// when picked. The host positions it next to the selection and renders it again (keyed by the annotation) after each
// change. A locked annotation shows why it can't change; its comments stay reachable.

export interface PdfAnnotationStyleChange {
	readonly color?: PdfRgb
	readonly opacity?: number
	readonly width?: number
}

export interface PdfAnnotationPopoverProps {
	info: PdfAnnotationInfo
	className?: string | undefined
	onStyle: (change: PdfAnnotationStyleChange) => void
	onComment: () => void
	onDelete: () => void
	// A file attachment: downloads its file (application/octet-stream, never opened).
	onDownload?: () => void
	downloadLabel?: string
}

function sliderValue(value: number | readonly number[]): number {
	return typeof value === "number" ? value : (value[0] ?? 0)
}

export function PdfAnnotationPopover({
	info,
	className,
	onStyle,
	onComment,
	onDelete,
	onDownload,
	downloadLabel
}: PdfAnnotationPopoverProps) {
	const { t } = useTranslation("preview")
	const [colorOpen, setColorOpen] = useState(false)
	// A slider's value while it is dragged (null: the annotation's own).
	const [opacity, setOpacity] = useState<number | null>(null)
	const [width, setWidth] = useState<number | null>(null)
	const shownOpacity = opacity ?? opacityPercent(info.opacity)
	const shownWidth = width ?? clampWidth(info.width)
	const chosen = colorKey(info.color)

	return (
		<div
			role="toolbar"
			aria-label={t("previewPdfAnnotPopover")}
			data-preview-surface
			className={cn(
				"flex items-center gap-2 rounded-lg border border-border bg-popover p-1.5 text-popover-foreground shadow-md",
				className
			)}
		>
			{info.locked ? (
				<p className="px-1 text-xs text-muted-foreground">{t("previewPdfAnnotLocked")}</p>
			) : (
				<>
					{hasColor(info) ? (
						<Popover
							open={colorOpen}
							onOpenChange={setColorOpen}
						>
							<PopoverTrigger
								render={
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label={t("previewPdfAnnotColor")}
										title={t("previewPdfAnnotColor")}
										onMouseDown={keepFocus}
									/>
								}
							>
								<span
									aria-hidden="true"
									className="size-4 rounded-full ring-1 ring-border"
									style={{ backgroundColor: chosen === undefined ? "transparent" : `#${chosen}` }}
								/>
							</PopoverTrigger>
							<PopoverContent
								data-preview-surface
								aria-label={t("previewPdfAnnotColor")}
								className="w-auto gap-2 p-3"
							>
								<DocxColorGrid
									theme={[]}
									standard={STANDARD_SWATCHES}
									chosen={chosen}
									onPick={swatch => {
										const rgb = swatch === null ? null : hexToRgb(swatch.rgb)

										setColorOpen(false)

										if (rgb !== null) onStyle({ color: rgb })
									}}
								/>
							</PopoverContent>
						</Popover>
					) : null}
					<label className="flex items-center gap-1.5 text-xs">
						<span className="sr-only">{t("previewPdfAnnotOpacity")}</span>
						<Slider
							className="w-20 shrink-0 data-horizontal:w-20"
							min={10}
							max={100}
							step={5}
							value={shownOpacity}
							getAriaValueText={(_formatted, value) => t("previewPdfAnnotOpacityValue", { percent: value })}
							onValueChange={value => {
								setOpacity(sliderValue(value))
							}}
							onValueCommitted={value => {
								setOpacity(null)
								onStyle({ opacity: sliderValue(value) / 100 })
							}}
						/>
						<span
							aria-hidden="true"
							className="w-8 text-muted-foreground tabular-nums"
						>
							{t("previewPdfAnnotOpacityValue", { percent: shownOpacity })}
						</span>
					</label>
					{hasStrokeWidth(info) ? (
						<label className="flex items-center gap-1.5 text-xs">
							<span className="sr-only">{t("previewPdfAnnotWidth")}</span>
							<Slider
								className="w-20 shrink-0 data-horizontal:w-20"
								min={PDF_ANNOT_WIDTH_MIN}
								max={PDF_ANNOT_WIDTH_MAX}
								step={PDF_ANNOT_WIDTH_STEP}
								value={shownWidth}
								getAriaValueText={(_formatted, value) => t("previewPdfAnnotWidthValue", { width: value })}
								onValueChange={value => {
									setWidth(sliderValue(value))
								}}
								onValueCommitted={value => {
									setWidth(null)
									onStyle({ width: sliderValue(value) })
								}}
							/>
							<span
								aria-hidden="true"
								className="w-10 text-muted-foreground tabular-nums"
							>
								{t("previewPdfAnnotWidthValue", { width: shownWidth })}
							</span>
						</label>
					) : null}
				</>
			)}
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={t("previewPdfAnnotComment")}
				title={t("previewPdfAnnotComment")}
				onMouseDown={keepFocus}
				onClick={onComment}
			>
				<MessageSquareIcon />
			</Button>
			{onDownload === undefined ? null : (
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={downloadLabel}
					title={downloadLabel}
					onMouseDown={keepFocus}
					onClick={onDownload}
				>
					<DownloadIcon />
				</Button>
			)}
			{info.locked ? null : (
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={t("previewPdfAnnotDelete")}
					title={t("previewPdfAnnotDelete")}
					onMouseDown={keepFocus}
					onClick={onDelete}
				>
					<Trash2Icon />
				</Button>
			)}
		</div>
	)
}
