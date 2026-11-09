import { useTranslation } from "react-i18next"
import { ChevronLeftIcon, ChevronRightIcon, GalleryVerticalIcon, MaximizeIcon, MenuIcon, SquareIcon } from "lucide-react"
import type { ShowController } from "@filen/office/react/presentation"
import type { SlideRef } from "@filen/office/core/presentation"
import { Button } from "@/components/ui/button"
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
	DropdownMenuSubTrigger,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"

// The status bar of a show browsed by an individual (PowerPoint's show in a window): the slide counter on the left;
// Previous, Menu and Next on the right. The menu: Previous, Next, Go to slide, Full screen (where the browser has it)
// and End show. Rendered by the stage under the slide; it re-renders only when the slide or screen changes.

export interface BrowseBarProps {
	// The deck index on stage (undefined before the first slide shows).
	readonly index: number | undefined
	readonly slides: readonly { readonly ref: SlideRef; readonly hidden: boolean }[]
	readonly controller: () => ShowController | undefined
	// The page is in full screen; undefined: the browser has none to offer.
	readonly fullscreen: boolean | undefined
	readonly onFullscreen: () => void
}

export function BrowseBar({ index, slides, controller, fullscreen, onFullscreen }: BrowseBarProps) {
	const { t } = useTranslation("preview")

	return (
		<div
			role="toolbar"
			aria-label={t("previewPptxShowBrowseBar")}
			className="flex h-7 items-center justify-between gap-2 border-t border-border bg-muted px-3 text-xs text-muted-foreground select-none"
		>
			<span>{index === undefined ? "" : t("previewPptxSlideLabel", { current: index + 1, total: slides.length })}</span>
			<div className="flex items-center gap-0.5">
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label={t("previewPptxPresenterPrevious")}
					onClick={() => controller()?.prev()}
				>
					<ChevronLeftIcon />
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger
						render={
							<Button
								type="button"
								variant="ghost"
								size="icon-xs"
								aria-label={t("previewPptxShowBrowseMenu")}
							/>
						}
					>
						<MenuIcon />
					</DropdownMenuTrigger>
					<DropdownMenuContent
						data-preview-surface
						side="top"
						align="end"
						onContextMenu={event => {
							event.preventDefault()
						}}
					>
						<DropdownMenuItem onClick={() => controller()?.prev()}>
							<ChevronLeftIcon />
							{t("previewPptxPresenterPrevious")}
						</DropdownMenuItem>
						<DropdownMenuItem onClick={() => controller()?.next()}>
							<ChevronRightIcon />
							{t("previewPptxPresenterNextButton")}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuSub>
							<DropdownMenuSubTrigger>
								<GalleryVerticalIcon />
								{t("previewPptxShowBrowseGoTo")}
							</DropdownMenuSubTrigger>
							<DropdownMenuSubContent className="max-h-80 overflow-y-auto">
								<DropdownMenuRadioGroup
									value={index ?? -1}
									onValueChange={(target: number) => {
										controller()?.goto(target)
									}}
								>
									{slides.map((slide, at) => (
										<DropdownMenuRadioItem
											key={slide.ref}
											value={at}
											closeOnClick
										>
											{t(slide.hidden ? "previewPptxShowMenuSlideHidden" : "previewPptxShowMenuSlide", {
												number: at + 1
											})}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuSubContent>
						</DropdownMenuSub>
						{fullscreen === undefined ? null : (
							<DropdownMenuCheckboxItem
								checked={fullscreen}
								closeOnClick
								onCheckedChange={onFullscreen}
							>
								<MaximizeIcon />
								{t("previewPptxShowBrowseFullScreen")}
							</DropdownMenuCheckboxItem>
						)}
						<DropdownMenuSeparator />
						<DropdownMenuItem onClick={() => controller()?.end()}>
							<SquareIcon />
							{t("previewPptxPresenterEnd")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label={t("previewPptxPresenterNextButton")}
					onClick={() => controller()?.next()}
				>
					<ChevronRightIcon />
				</Button>
			</div>
		</div>
	)
}
