import { useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import {
	ChevronDownIcon,
	ChevronFirstIcon,
	ChevronLastIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
	MaximizeIcon,
	MinimizeIcon,
	ZoomInIcon,
	ZoomOutIcon
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { RibbonButton, RibbonMenuTrigger } from "@/features/office/components/ribbon/ribbonControls"
import { toggleViewerFullScreen, typedPage, type ZoomFit } from "@/features/preview/components/commandBar.logic"
import { fullscreenSupported, useIsFullscreen } from "@/lib/media/fullscreen"
import { log } from "@/lib/log"

// The controls the document viewers' command bars share (OfficeCommandBar): the File menu's button, page
// navigation with a page number field, zoom with its menu of steps and fits, and full screen.

// The File menu, first in a command bar (F6 lands on it: data-ribbon-file); its items are the children.
export function CommandFileMenu({ children }: { children: ReactNode }) {
	const { t } = useTranslation("preview")

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
				{children}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// The page in view as a field: a number typed and Enter (or leaving the field) goes there, Escape puts the page in
// view back. `ends` adds first and last.
export function PageControls({
	page,
	total,
	ends,
	canPrevious,
	canNext,
	onGo,
	onPrevious,
	onNext,
	onFirst,
	onLast
}: {
	page: number
	total: number
	ends: boolean
	canPrevious: boolean
	canNext: boolean
	onGo: (page: number) => void
	onPrevious: () => void
	onNext: () => void
	onFirst: () => void
	onLast: () => void
}) {
	const { t } = useTranslation("preview")
	// What is typed, while it differs from the page in view.
	const [draft, setDraft] = useState<string | null>(null)

	const commit = (): void => {
		if (draft === null) {
			return
		}

		const typed = typedPage(draft, total)

		setDraft(null)

		if (typed !== null) {
			onGo(typed)
		}
	}

	return (
		<>
			{ends ? (
				<RibbonButton
					label={t("previewCommandBarFirstPage")}
					icon={<ChevronFirstIcon />}
					disabled={!canPrevious}
					onClick={onFirst}
				/>
			) : null}
			<RibbonButton
				label={t("previewPdfPreviousPageAction")}
				icon={<ChevronLeftIcon />}
				disabled={!canPrevious}
				onClick={onPrevious}
			/>
			<span className="flex shrink-0 items-center gap-1 px-0.5 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
				<input
					type="text"
					inputMode="numeric"
					aria-label={t("previewCommandBarPageNumber")}
					value={draft ?? String(page)}
					className="h-6 w-10 rounded-lg bg-muted/60 px-1 text-center text-xs leading-5 text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30"
					onChange={event => {
						setDraft(event.target.value.replace(/\D/g, ""))
					}}
					onFocus={event => {
						event.target.select()
					}}
					onBlur={commit}
					onKeyDown={event => {
						if (event.key === "Enter") {
							event.preventDefault()
							commit()
						} else if (event.key === "Escape" && draft !== null) {
							// Taken here: the preview overlay closes on an Escape nothing inside took.
							event.preventDefault()
							setDraft(null)
						}
					}}
				/>
				{t("previewCommandBarPageTotal", { total })}
			</span>
			<RibbonButton
				label={t("previewPdfNextPageAction")}
				icon={<ChevronRightIcon />}
				disabled={!canNext}
				onClick={onNext}
			/>
			{ends ? (
				<RibbonButton
					label={t("previewCommandBarLastPage")}
					icon={<ChevronLastIcon />}
					disabled={!canNext}
					onClick={onLast}
				/>
			) : null}
		</>
	)
}

// − / the zoom menu (steps, then the fits a viewer offers) / +.
export function ZoomControls({
	percent,
	presets,
	fits,
	mode,
	canIn,
	canOut,
	onIn,
	onOut,
	onPercent,
	onFit
}: {
	percent: number
	presets: readonly number[]
	fits: readonly ZoomFit[]
	// The fit in effect, or "custom".
	mode: ZoomFit | "custom"
	canIn: boolean
	canOut: boolean
	onIn: () => void
	onOut: () => void
	onPercent: (percent: number) => void
	onFit: (fit: ZoomFit) => void
}) {
	const { t } = useTranslation("preview")
	const value = mode === "custom" ? String(percent) : mode

	return (
		<>
			<RibbonButton
				label={t("previewPdfZoomOutAction")}
				icon={<ZoomOutIcon />}
				disabled={!canOut}
				onClick={onOut}
			/>
			<DropdownMenu>
				<RibbonMenuTrigger
					label={t("previewCommandBarZoomLevel", { percent })}
					icon={null}
					text={t("previewPdfZoomIndicator", { percent })}
				/>
				<DropdownMenuContent
					align="center"
					data-preview-surface
					className="min-w-36"
				>
					<DropdownMenuRadioGroup
						value={value}
						onValueChange={(next: string) => {
							if (next === "fitWidth" || next === "fitPage") {
								onFit(next)
							} else {
								onPercent(Number(next))
							}
						}}
					>
						{presets.map(preset => (
							<DropdownMenuRadioItem
								key={preset}
								value={String(preset)}
								closeOnClick
							>
								{t("previewPdfZoomIndicator", { percent: preset })}
							</DropdownMenuRadioItem>
						))}
						{fits.length > 0 ? <DropdownMenuSeparator /> : null}
						{fits.map(fit => (
							<DropdownMenuRadioItem
								key={fit}
								value={fit}
								closeOnClick
							>
								{t(fit === "fitWidth" ? "previewDocxFitWidth" : "previewCommandBarFitPage")}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
			<RibbonButton
				label={t("previewPdfZoomInAction")}
				icon={<ZoomInIcon />}
				disabled={!canIn}
				onClick={onIn}
			/>
		</>
	)
}

// The whole page full screen (toggleViewerFullScreen); absent where the browser has no element fullscreen (iPhone).
export function FullScreenButton() {
	const { t } = useTranslation("preview")
	const active = useIsFullscreen(document.documentElement)

	if (!fullscreenSupported()) {
		return null
	}

	return (
		<RibbonButton
			label={t(active ? "previewCommandBarExitFullScreen" : "previewCommandBarFullScreen")}
			icon={active ? <MinimizeIcon /> : <MaximizeIcon />}
			pressed={active}
			onClick={() => {
				toggleViewerFullScreen().catch((error: unknown) => {
					log.warn("preview", "full screen refused", { error })
				})
			}}
		/>
	)
}
