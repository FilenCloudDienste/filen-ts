import { useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeftIcon, ArrowRightIcon, GalleryVerticalIcon, MonitorIcon, MousePointer2Icon, SquareIcon, Trash2Icon } from "lucide-react"
import { INK_COLORS, type InkStore, type InkTool, type ShowController, type ShowScreen } from "@filen/office/react/presentation"
import type { SlideRef } from "@filen/office/core/presentation"
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger
} from "@/components/ui/dropdown-menu"
import { INK_COLOR_LABELS, INK_TOOLS } from "@/features/presentation/components/presenter/inkTools"

// The slide show's shortcut menu (PowerPoint's right click, Shift+F10 or the Menu key in the show): Next, Previous,
// See all slides, Screen (black, white), Pointer options (the presenter's arrow, pen, highlighter, laser pointer,
// eraser, ink colour, erase all) and End show; only what the show's controller and ink do. It opens at the point the
// stage gave and gives focus back to the stage when it closes.

// Where the menu opens and what the show is at then (read once, as it opens).
export interface ShowMenuAt {
	readonly x: number
	readonly y: number
	readonly stage: HTMLElement
	// The deck index and slide on stage (undefined before the first slide shows).
	readonly index: number | undefined
	readonly slide: SlideRef | undefined
	readonly screen: ShowScreen
}

function PointerItems({ ink, slide }: { ink: InkStore; slide: SlideRef | undefined }) {
	const { t } = useTranslation("preview")
	const state = useSyncExternalStore(ink.subscribe, ink.getSnapshot)
	const drawing = state.tool === "pen" || state.tool === "highlighter"

	return (
		<>
			<DropdownMenuRadioGroup
				value={state.tool}
				onValueChange={(tool: InkTool) => {
					ink.setTool(tool)
				}}
			>
				{INK_TOOLS.map(entry => (
					<DropdownMenuRadioItem
						key={entry.tool}
						value={entry.tool}
					>
						{entry.icon}
						{t(entry.label)}
					</DropdownMenuRadioItem>
				))}
			</DropdownMenuRadioGroup>
			{drawing ? (
				<DropdownMenuSub>
					<DropdownMenuSubTrigger>{t("previewPptxInkColor")}</DropdownMenuSubTrigger>
					<DropdownMenuSubContent>
						<DropdownMenuRadioGroup
							value={state.color}
							onValueChange={(color: string) => {
								ink.setColor(color)
							}}
						>
							{INK_COLORS.map(color => {
								const label = INK_COLOR_LABELS[color]

								return (
									<DropdownMenuRadioItem
										key={color}
										value={color}
									>
										<span
											aria-hidden
											className="size-3.5 rounded-full border border-black/30"
											style={{ backgroundColor: `#${color}` }}
										/>
										{label === undefined ? color : t(label)}
									</DropdownMenuRadioItem>
								)
							})}
						</DropdownMenuRadioGroup>
					</DropdownMenuSubContent>
				</DropdownMenuSub>
			) : null}
			<DropdownMenuSeparator />
			<DropdownMenuItem
				disabled={slide === undefined || !state.inked}
				onClick={() => {
					if (slide !== undefined) ink.clear(slide)
				}}
			>
				<Trash2Icon />
				{t("previewPptxInkEraseAll")}
			</DropdownMenuItem>
		</>
	)
}

export function ShowMenu({
	at,
	slides,
	controller,
	ink,
	onClose
}: {
	// Open there; undefined: closed.
	at: ShowMenuAt | undefined
	slides: readonly { readonly ref: SlideRef; readonly hidden: boolean }[]
	controller: () => ShowController | undefined
	// The presenter's ink (no Pointer options without it).
	ink: InkStore | undefined
	// escaped: Escape closed it (in full screen the browser also leaves full screen for that key).
	onClose: (escaped: boolean) => void
}) {
	const { t } = useTranslation("preview")
	// The point as a zero-size box for the positioner (the menu has no trigger).
	const anchor =
		at === undefined
			? undefined
			: { getBoundingClientRect: () => DOMRect.fromRect({ x: at.x, y: at.y, width: 0, height: 0 }), contextElement: at.stage }

	return (
		<DropdownMenu
			open={at !== undefined}
			onOpenChange={(open, details) => {
				if (!open) onClose(details.reason === "escape-key")
			}}
		>
			{at === undefined ? null : (
				<DropdownMenuContent
					data-preview-surface
					aria-label={t("previewPptxShowMenu")}
					anchor={anchor}
					side="bottom"
					align="start"
					sideOffset={0}
					finalFocus={() => (at.stage.isConnected ? at.stage : true)}
					// The browser's own menu (a second right click, the Menu key's keyup) never shows over this one.
					onContextMenu={event => {
						event.preventDefault()
					}}
				>
					<DropdownMenuItem onClick={() => controller()?.next()}>
						<ArrowRightIcon />
						{t("previewPptxPresenterNextButton")}
					</DropdownMenuItem>
					<DropdownMenuItem onClick={() => controller()?.prev()}>
						<ArrowLeftIcon />
						{t("previewPptxPresenterPrevious")}
					</DropdownMenuItem>
					<DropdownMenuSub>
						<DropdownMenuSubTrigger>
							<GalleryVerticalIcon />
							{t("previewPptxShowMenuSeeAll")}
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent className="max-h-80 overflow-y-auto">
							<DropdownMenuRadioGroup
								value={at.index ?? -1}
								onValueChange={(index: number) => {
									controller()?.goto(index)
								}}
							>
								{slides.map((slide, index) => (
									<DropdownMenuRadioItem
										key={slide.ref}
										value={index}
									>
										{t(slide.hidden ? "previewPptxShowMenuSlideHidden" : "previewPptxShowMenuSlide", {
											number: index + 1
										})}
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuSubContent>
					</DropdownMenuSub>
					<DropdownMenuSeparator />
					<DropdownMenuSub>
						<DropdownMenuSubTrigger>
							<MonitorIcon />
							{t("previewPptxShowMenuScreen")}
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent>
							<DropdownMenuCheckboxItem
								checked={at.screen === "black"}
								onCheckedChange={() => controller()?.black()}
							>
								{t("previewPptxPresenterBlack")}
							</DropdownMenuCheckboxItem>
							<DropdownMenuCheckboxItem
								checked={at.screen === "white"}
								onCheckedChange={() => controller()?.white()}
							>
								{t("previewPptxPresenterWhite")}
							</DropdownMenuCheckboxItem>
						</DropdownMenuSubContent>
					</DropdownMenuSub>
					{ink === undefined ? null : (
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>
								<MousePointer2Icon />
								{t("previewPptxShowMenuPointer")}
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent>
								<PointerItems
									ink={ink}
									slide={at.slide}
								/>
							</DropdownMenuSubContent>
						</DropdownMenuSub>
					)}
					<DropdownMenuSeparator />
					<DropdownMenuItem onClick={() => controller()?.end()}>
						<SquareIcon />
						{t("previewPptxPresenterEnd")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			)}
		</DropdownMenu>
	)
}
