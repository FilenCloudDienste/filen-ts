import { useSyncExternalStore, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { CircleDotIcon, EraserIcon, HighlighterIcon, MousePointer2Icon, PenLineIcon, Trash2Icon } from "lucide-react"
import { INK_COLORS, type InkStore, type InkTool } from "@filen/office/react/presentation"
import type { SlideRef } from "@filen/office/core/presentation"
import { Button } from "@/components/ui/button"
import { cn } from "@filen/shared"
import type { PreviewKey } from "@/lib/i18n"

// The pointer and ink tools (arrow, pen, highlighter, laser pointer, eraser), the pen's colours and Erase all, in the
// presenter view and over the stage. Plain buttons only: menus and tooltips portal to the page's body, which is the
// wrong window for the presenter's popup.

const TOOLS: readonly { readonly tool: InkTool; readonly label: PreviewKey; readonly icon: ReactNode }[] = [
	{ tool: "none", label: "previewPptxInkArrow", icon: <MousePointer2Icon /> },
	{ tool: "pen", label: "previewPptxInkPen", icon: <PenLineIcon /> },
	{ tool: "highlighter", label: "previewPptxInkHighlighter", icon: <HighlighterIcon /> },
	{ tool: "laser", label: "previewPptxInkLaser", icon: <CircleDotIcon /> },
	{ tool: "eraser", label: "previewPptxInkEraser", icon: <EraserIcon /> }
]

const COLOR_LABELS: Readonly<Record<string, PreviewKey>> = {
	FF0000: "previewPptxInkColorRed",
	"0070C0": "previewPptxInkColorBlue",
	"00B050": "previewPptxInkColorGreen",
	FFFF00: "previewPptxInkColorYellow",
	"000000": "previewPptxInkColorBlack",
	FFFFFF: "previewPptxInkColorWhite"
}

export function InkToolbar({
	ink,
	slide,
	variant,
	className
}: {
	ink: InkStore
	slide: SlideRef | undefined
	// "stage": light on dark over the slideshow.
	variant: "presenter" | "stage"
	className?: string
}) {
	const { t } = useTranslation("preview")
	const state = useSyncExternalStore(ink.subscribe, ink.getSnapshot)
	const drawing = state.tool === "pen" || state.tool === "highlighter"
	const stage = variant === "stage"
	const buttonClass = stage ? "text-white hover:bg-white/20 hover:text-white aria-pressed:bg-white/25" : "aria-pressed:bg-muted"

	return (
		<div
			role="toolbar"
			aria-label={t("previewPptxInkTools")}
			className={cn("flex flex-wrap items-center gap-0.5", stage && "rounded-2xl bg-black/55 p-1", className)}
			// The stage takes clicks to go on; the toolbar's are its own.
			onClick={event => {
				event.stopPropagation()
			}}
		>
			{TOOLS.map(entry => (
				<Button
					key={entry.tool}
					variant="ghost"
					size="icon-sm"
					className={buttonClass}
					aria-label={t(entry.label)}
					title={t(entry.label)}
					aria-pressed={state.tool === entry.tool}
					onClick={() => {
						ink.setTool(entry.tool)
					}}
				>
					{entry.icon}
				</Button>
			))}
			{drawing ? (
				<div
					role="group"
					aria-label={t("previewPptxInkColor")}
					className="flex items-center gap-0.5 px-1"
				>
					{INK_COLORS.map(color => {
						const label = COLOR_LABELS[color]

						return (
							<button
								key={color}
								type="button"
								aria-label={label === undefined ? color : t(label)}
								title={label === undefined ? color : t(label)}
								aria-pressed={state.color === color}
								className="size-6 rounded-full border border-black/30 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:ring-2 aria-pressed:ring-primary aria-pressed:ring-offset-1"
								style={{ backgroundColor: `#${color}` }}
								onClick={() => {
									ink.setColor(color)
								}}
							/>
						)
					})}
				</div>
			) : null}
			<Button
				variant="ghost"
				size="icon-sm"
				className={buttonClass}
				aria-label={t("previewPptxInkEraseAll")}
				title={t("previewPptxInkEraseAll")}
				disabled={slide === undefined || !state.inked}
				onClick={() => {
					if (slide !== undefined) ink.clear(slide)
				}}
			>
				<Trash2Icon />
			</Button>
		</div>
	)
}
