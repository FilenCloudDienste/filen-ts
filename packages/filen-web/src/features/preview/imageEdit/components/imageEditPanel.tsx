import { useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
	ApertureIcon,
	ArrowUpRightIcon,
	BlendIcon,
	BrushIcon,
	ChevronDownIcon,
	CropIcon,
	EraserIcon,
	FlipHorizontal2Icon,
	FlipVertical2Icon,
	HighlighterIcon,
	PaletteIcon,
	PenLineIcon,
	RotateCcwIcon,
	RotateCcwSquareIcon,
	SunMediumIcon,
	TypeIcon
} from "lucide-react"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import type { Adjustments, AspectPreset, ImageEditRecipe, MarkupColor } from "@/features/preview/imageEdit/types"
import { FILTER_PRESETS } from "@/features/preview/imageEdit/lib/filters"
import { EditSlider } from "@/features/preview/imageEdit/components/editSlider"
import { MARKUP_COLORS, type MarkupTool, type MarkupWidth } from "@/features/preview/imageEdit/components/markupStyle"
import type { NamespaceKey } from "@/lib/i18n"

type PreviewKey = NamespaceKey<"preview">

export type EditTab = "adjust" | "crop" | "filters" | "markup"

const TABS: readonly { id: EditTab; labelKey: PreviewKey; icon: ReactNode }[] = [
	{ id: "adjust", labelKey: "previewImageEditTabAdjust", icon: <SunMediumIcon /> },
	{ id: "crop", labelKey: "previewImageEditTabCrop", icon: <CropIcon /> },
	{ id: "filters", labelKey: "previewImageEditTabFilters", icon: <BlendIcon /> },
	{ id: "markup", labelKey: "previewImageEditTabMarkup", icon: <BrushIcon /> }
]

type AdjustSectionId = "light" | "colour" | "detail"

interface AdjustmentDef {
	key: keyof Adjustments
	labelKey: PreviewKey
	min: number
}

const ADJUST_SECTIONS: readonly { id: AdjustSectionId; labelKey: PreviewKey; icon: ReactNode; sliders: readonly AdjustmentDef[] }[] = [
	{
		id: "light",
		labelKey: "previewImageEditSectionLight",
		icon: <SunMediumIcon />,
		sliders: [
			{ key: "exposure", labelKey: "previewImageEditExposure", min: -100 },
			{ key: "brightness", labelKey: "previewImageEditBrightness", min: -100 },
			{ key: "contrast", labelKey: "previewImageEditContrast", min: -100 },
			{ key: "highlights", labelKey: "previewImageEditHighlights", min: -100 },
			{ key: "shadows", labelKey: "previewImageEditShadows", min: -100 }
		]
	},
	{
		id: "colour",
		labelKey: "previewImageEditSectionColour",
		icon: <PaletteIcon />,
		sliders: [
			{ key: "warmth", labelKey: "previewImageEditWarmth", min: -100 },
			{ key: "tint", labelKey: "previewImageEditTint", min: -100 },
			{ key: "saturation", labelKey: "previewImageEditSaturation", min: -100 },
			{ key: "vibrance", labelKey: "previewImageEditVibrance", min: -100 }
		]
	},
	{
		id: "detail",
		labelKey: "previewImageEditSectionDetail",
		icon: <ApertureIcon />,
		sliders: [
			{ key: "sharpness", labelKey: "previewImageEditSharpness", min: 0 },
			{ key: "vignette", labelKey: "previewImageEditVignette", min: 0 }
		]
	}
]

const ASPECTS: readonly { id: AspectPreset; labelKey: PreviewKey | null }[] = [
	{ id: "free", labelKey: "previewImageEditAspectFree" },
	{ id: "original", labelKey: "previewImageEditAspectOriginal" },
	{ id: "square", labelKey: "previewImageEditAspectSquare" },
	{ id: "4:3", labelKey: null },
	{ id: "3:2", labelKey: null },
	{ id: "16:9", labelKey: null },
	{ id: "3:4", labelKey: null },
	{ id: "2:3", labelKey: null },
	{ id: "9:16", labelKey: null }
]

const TOOLS: readonly { id: MarkupTool; labelKey: PreviewKey; icon: ReactNode }[] = [
	{ id: "pen", labelKey: "previewImageEditPen", icon: <PenLineIcon /> },
	{ id: "highlighter", labelKey: "previewImageEditHighlighter", icon: <HighlighterIcon /> },
	{ id: "arrow", labelKey: "previewImageEditArrow", icon: <ArrowUpRightIcon /> },
	{ id: "text", labelKey: "previewImageEditText", icon: <TypeIcon /> },
	{ id: "eraser", labelKey: "previewImageEditEraser", icon: <EraserIcon /> }
]

const WIDTHS: readonly { id: MarkupWidth; labelKey: PreviewKey; dot: string }[] = [
	{ id: 0, labelKey: "previewImageEditWidthThin", dot: "size-1.5" },
	{ id: 1, labelKey: "previewImageEditWidthMedium", dot: "size-2.5" },
	{ id: 2, labelKey: "previewImageEditWidthThick", dot: "size-3.5" }
]

// A segmented control's well, and its segments as they look chosen or not.
const SEGMENTED_CLASS = "flex gap-0.5 rounded-full bg-canvas p-1"
// flex-1 overrides the icon button's width (its basis is 0); its height stays.
const SEGMENT_CLASS = "flex-1 rounded-full"
const SEGMENT_ON_CLASS = "bg-background text-foreground shadow-sm ring-1 ring-border hover:bg-background"
const SEGMENT_OFF_CLASS = "text-muted-foreground hover:bg-muted"

// The ids tab and panel share.
function tabIds(base: string, tab: EditTab): { tab: string; panel: string } {
	return { tab: `${base}-tab-${tab}`, panel: `${base}-panel-${tab}` }
}

function Section(props: { label: string; children: ReactNode }) {
	return (
		<div
			role="group"
			aria-label={props.label}
			className="flex flex-col gap-2.5"
		>
			<span className="text-xs font-medium text-muted-foreground">{props.label}</span>
			{props.children}
		</div>
	)
}

// A collapsible group of Adjust sliders. Its header marks a group with any slider off zero and offers to zero them;
// the reset keeps its place while hidden so the header never reflows.
function AdjustSection(props: {
	label: string
	icon: ReactNode
	open: boolean
	modified: boolean
	resetLabel: string
	onOpenChange: (open: boolean) => void
	onReset: () => void
	children: ReactNode
}) {
	return (
		<Collapsible
			open={props.open}
			onOpenChange={props.onOpenChange}
			className="border-b border-border last:border-b-0"
		>
			<div className="flex items-center gap-1">
				<CollapsibleTrigger className="group/section flex min-w-0 flex-1 items-center gap-2.5 rounded-xl py-2.5 text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
					<span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-data-panel-open/section:text-foreground [&_svg]:size-4">
						{props.icon}
					</span>
					<span className="truncate">{props.label}</span>
					{props.modified ? (
						<span
							aria-hidden="true"
							className="size-1.5 shrink-0 rounded-full bg-edit-modified"
						/>
					) : null}
					<ChevronDownIcon className="ml-auto size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-panel-open/section:rotate-180 motion-reduce:transition-none" />
				</CollapsibleTrigger>
				<TooltipIconButton
					label={props.resetLabel}
					disabled={!props.modified}
					className={cn(!props.modified && "invisible")}
					onClick={props.onReset}
				>
					<RotateCcwIcon />
				</TooltipIconButton>
			</div>
			<CollapsibleContent className="-mx-1 h-(--collapsible-panel-height) overflow-hidden px-1 transition-[height] duration-200 ease-out data-ending-style:h-0 data-starting-style:h-0 motion-reduce:transition-none">
				<div className="flex flex-col gap-3.5 pt-1 pb-4">{props.children}</div>
			</CollapsibleContent>
		</Collapsible>
	)
}

// A filter's thumbnail, drawn from its bitmap (owned and closed by the editor).
function FilterThumbnail(props: { bitmap: ImageBitmap | undefined }) {
	return (
		<canvas
			aria-hidden="true"
			className="block aspect-square w-full bg-muted object-cover"
			ref={canvas => {
				const bitmap = props.bitmap

				// A closed bitmap (replaced while this render was in flight) reads 0 wide.
				if (canvas === null || bitmap === undefined || bitmap.width === 0) {
					return
				}

				canvas.width = bitmap.width
				canvas.height = bitmap.height
				canvas.getContext("2d")?.drawImage(bitmap, 0, 0)
			}}
		/>
	)
}

export interface EditPanelProps {
	idBase: string
	tab: EditTab
	recipe: ImageEditRecipe
	// The unfiltered one, then one per FILTER_PRESETS entry, once drawn.
	thumbnails: readonly ImageBitmap[] | null
	tool: MarkupTool
	color: MarkupColor
	width: MarkupWidth
	onTab: (tab: EditTab) => void
	onAdjust: (key: keyof Adjustments, value: number, coalesce: boolean) => void
	// Zeroes these sliders as one undo step.
	onResetAdjustments: (keys: readonly (keyof Adjustments)[]) => void
	onStraighten: (angle: number) => void
	onRotateLeft: () => void
	onFlip: (axis: "horizontal" | "vertical") => void
	onAspect: (aspect: AspectPreset) => void
	onResetGeometry: () => void
	onFilter: (id: string | null) => void
	onTool: (tool: MarkupTool) => void
	onColor: (color: MarkupColor) => void
	onWidth: (width: MarkupWidth) => void
}

// The tools beside the picture (beneath it under the sm breakpoint): Adjust, Crop, Filters and Markup tabs.
export function ImageEditPanel(props: EditPanelProps) {
	const { t } = useTranslation("preview")
	const geometry = props.recipe.geometry
	// Kept here, not in the Adjust tab, so a group stays as left across tab switches.
	const [openSections, setOpenSections] = useState<ReadonlySet<AdjustSectionId>>(() => new Set(["light"]))

	const handleTabKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
		const index = TABS.findIndex(tab => tab.id === props.tab)
		const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0

		if (step === 0) {
			return
		}

		event.preventDefault()

		const next = TABS[(index + step + TABS.length) % TABS.length]

		if (next !== undefined) {
			props.onTab(next.id)
			document.getElementById(tabIds(props.idBase, next.id).tab)?.focus()
		}
	}

	const ids = tabIds(props.idBase, props.tab)

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div
				role="tablist"
				aria-label={t("previewImageEditTools")}
				className="mx-4 mt-3 grid shrink-0 grid-cols-4 gap-0.5 rounded-full bg-canvas p-1 sm:rounded-2xl"
				onKeyDown={handleTabKey}
			>
				{TABS.map(tab => {
					const selected = tab.id === props.tab

					return (
						<button
							key={tab.id}
							type="button"
							id={tabIds(props.idBase, tab.id).tab}
							role="tab"
							aria-selected={selected}
							aria-controls={tabIds(props.idBase, tab.id).panel}
							tabIndex={selected ? 0 : -1}
							className={cn(
								"flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-full px-2 text-xs font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/30 motion-reduce:transition-none sm:h-auto sm:flex-col sm:gap-0.5 sm:rounded-xl sm:py-1.5 sm:text-[11px] [&_svg]:size-4 [&_svg]:shrink-0",
								selected
									? "bg-background text-foreground shadow-sm ring-1 ring-border"
									: "text-muted-foreground hover:text-foreground"
							)}
							onClick={() => {
								props.onTab(tab.id)
							}}
						>
							{tab.icon}
							{/* Icons alone at phone width; the label still names the tab. Stacked under the icon in the inspector, where four
							side-by-side labels would not fit its width. */}
							<span className="truncate max-sm:sr-only">{t(tab.labelKey)}</span>
						</button>
					)
				})}
			</div>
			<div
				id={ids.panel}
				role="tabpanel"
				aria-labelledby={ids.tab}
				className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-4"
			>
				{props.tab === "adjust" ? (
					<div className="flex flex-col">
						{ADJUST_SECTIONS.map(section => {
							const modified = section.sliders.some(({ key }) => props.recipe.adjustments[key] !== 0)
							const label = t(section.labelKey)

							return (
								<AdjustSection
									key={section.id}
									label={label}
									icon={section.icon}
									open={openSections.has(section.id)}
									modified={modified}
									resetLabel={t("previewImageEditResetSection", { section: label })}
									onOpenChange={open => {
										setOpenSections(current => {
											const next = new Set(current)

											if (open) {
												next.add(section.id)
											} else {
												next.delete(section.id)
											}

											return next
										})
									}}
									onReset={() => {
										props.onResetAdjustments(section.sliders.map(({ key }) => key))
									}}
								>
									{section.sliders.map(({ key, labelKey, min }) => (
										<EditSlider
											key={key}
											label={t(labelKey)}
											value={props.recipe.adjustments[key]}
											min={min}
											max={100}
											step={1}
											neutral={0}
											onChange={value => {
												props.onAdjust(key, value, true)
											}}
											onReset={() => {
												props.onAdjust(key, 0, false)
											}}
										/>
									))}
								</AdjustSection>
							)
						})}
						<p className="pt-3 text-xs text-muted-foreground">{t("previewImageEditSliderResetHint")}</p>
					</div>
				) : null}
				{props.tab === "crop" ? (
					<div className="flex flex-col gap-6">
						<Section label={t("previewImageEditAspect")}>
							<div className="flex flex-wrap gap-1.5">
								{ASPECTS.map(({ id, labelKey }) => {
									const selected = geometry.aspect === id

									return (
										<button
											key={id}
											type="button"
											aria-pressed={selected}
											className={cn(
												"h-7 rounded-full px-3 text-xs font-medium tabular-nums transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/30 motion-reduce:transition-none",
												selected
													? "bg-primary text-primary-foreground"
													: "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
											)}
											onClick={() => {
												props.onAspect(id)
											}}
										>
											{labelKey === null ? id : t(labelKey)}
										</button>
									)
								})}
							</div>
						</Section>
						<EditSlider
							label={t("previewImageEditStraighten")}
							value={geometry.angle}
							min={-45}
							max={45}
							step={0.5}
							neutral={0}
							scale={{ step: 5, major: 15 }}
							format={value => t("previewImageEditDegrees", { degrees: Math.round(value * 10) / 10 })}
							onChange={props.onStraighten}
							onReset={() => {
								props.onStraighten(0)
							}}
						/>
						<div className="grid grid-cols-3 gap-2">
							<TurnButton
								label={t("previewImageEditRotateLeft")}
								icon={<RotateCcwSquareIcon />}
								onClick={props.onRotateLeft}
							/>
							<TurnButton
								label={t("previewImageEditFlipHorizontal")}
								icon={<FlipHorizontal2Icon />}
								onClick={() => {
									props.onFlip("horizontal")
								}}
							/>
							<TurnButton
								label={t("previewImageEditFlipVertical")}
								icon={<FlipVertical2Icon />}
								onClick={() => {
									props.onFlip("vertical")
								}}
							/>
						</div>
						<Button
							variant="ghost"
							size="sm"
							className="self-start text-muted-foreground"
							onClick={props.onResetGeometry}
						>
							<RotateCcwIcon data-icon="inline-start" />
							{t("previewImageEditResetCrop")}
						</Button>
					</div>
				) : null}
				{props.tab === "filters" ? (
					<div className="grid grid-cols-3 gap-x-2.5 gap-y-3">
						<FilterTile
							label={t("previewImageEditFilterNone")}
							selected={props.recipe.filter === null}
							onClick={() => {
								props.onFilter(null)
							}}
						>
							<FilterThumbnail bitmap={props.thumbnails?.[0]} />
						</FilterTile>
						{FILTER_PRESETS.map((preset, index) => (
							<FilterTile
								key={preset.id}
								label={t(preset.labelKey as PreviewKey)}
								selected={props.recipe.filter === preset.id}
								onClick={() => {
									props.onFilter(preset.id)
								}}
							>
								<FilterThumbnail bitmap={props.thumbnails?.[index + 1]} />
							</FilterTile>
						))}
					</div>
				) : null}
				{props.tab === "markup" ? (
					<div className="flex flex-col gap-6">
						<Section label={t("previewImageEditMarkupTool")}>
							<div className={SEGMENTED_CLASS}>
								{TOOLS.map(tool => {
									const selected = props.tool === tool.id

									return (
										<TooltipIconButton
											key={tool.id}
											label={t(tool.labelKey)}
											pressed={selected}
											className={cn(SEGMENT_CLASS, selected ? SEGMENT_ON_CLASS : SEGMENT_OFF_CLASS)}
											onClick={() => {
												props.onTool(tool.id)
											}}
										>
											{tool.icon}
										</TooltipIconButton>
									)
								})}
							</div>
						</Section>
						<Section label={t("previewImageEditColor")}>
							<div className="flex flex-wrap gap-1">
								{MARKUP_COLORS.map(({ color, labelKey }) => {
									const selected = props.color === color

									return (
										<TooltipIconButton
											key={color}
											label={t(labelKey)}
											pressed={selected}
											className="size-8 rounded-full"
											onClick={() => {
												props.onColor(color)
											}}
										>
											<span
												className={cn(
													"size-6 rounded-full transition-shadow motion-reduce:transition-none",
													selected
														? "ring-2 ring-foreground ring-offset-2 ring-offset-background"
														: "ring-1 ring-foreground/25"
												)}
												style={{ backgroundColor: color }}
											/>
										</TooltipIconButton>
									)
								})}
							</div>
						</Section>
						<Section label={t("previewImageEditWidth")}>
							<div className={cn(SEGMENTED_CLASS, "w-40")}>
								{WIDTHS.map(width => {
									const selected = props.width === width.id

									return (
										<TooltipIconButton
											key={width.id}
											label={t(width.labelKey)}
											pressed={selected}
											className={cn(SEGMENT_CLASS, selected ? SEGMENT_ON_CLASS : SEGMENT_OFF_CLASS)}
											onClick={() => {
												props.onWidth(width.id)
											}}
										>
											<span className={cn("rounded-full bg-current", width.dot)} />
										</TooltipIconButton>
									)
								})}
							</div>
						</Section>
					</div>
				) : null}
			</div>
		</div>
	)
}

// Rotate and flip: an icon over its name.
function TurnButton(props: { label: string; icon: ReactNode; onClick: () => void }) {
	return (
		<button
			type="button"
			className="flex min-w-0 flex-col items-center gap-1.5 rounded-xl bg-muted px-1 py-2.5 text-center text-[11px] leading-tight text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 active:translate-y-px motion-reduce:transition-none [&_svg]:size-4.5 [&_svg]:shrink-0"
			onClick={props.onClick}
		>
			{props.icon}
			{props.label}
		</button>
	)
}

function FilterTile(props: { label: string; selected: boolean; onClick: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			aria-pressed={props.selected}
			className="group/tile flex min-w-0 flex-col items-center gap-1.5 text-xs outline-none"
			onClick={props.onClick}
		>
			<span
				className={cn(
					"block w-full overflow-hidden rounded-xl ring-offset-2 ring-offset-background transition-shadow group-focus-visible/tile:outline-2 group-focus-visible/tile:outline-offset-4 group-focus-visible/tile:outline-ring motion-reduce:transition-none",
					props.selected ? "ring-2 ring-primary" : "ring-1 ring-border group-hover/tile:ring-foreground/40"
				)}
			>
				{props.children}
			</span>
			<span className={cn("w-full truncate text-center", props.selected ? "font-medium text-foreground" : "text-muted-foreground")}>
				{props.label}
			</span>
		</button>
	)
}
