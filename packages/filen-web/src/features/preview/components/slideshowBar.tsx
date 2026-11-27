import { useEffect, useRef, useState, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { FoldersIcon, PauseIcon, PlayIcon, ShuffleIcon, SkipBackIcon, SkipForwardIcon, XIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { MEDIA_GLASS_SURFACE_CLASS, MEDIA_GLASS_TONE_CLASS } from "@/components/ui/surface"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { TOGGLE_ON_CLASS } from "@/components/media/toggleOn"
import type { Slideshow } from "@/features/preview/hooks/useSlideshow"
import { SLIDESHOW_INTERVALS } from "@/features/preview/lib/slideshow.logic"
import { setSlideshowPrefs, useSlideshowPrefs } from "@/features/preview/lib/slideshowPrefs"
import { CONTROLS_IDLE_MS, controlsVisible, IdleTimer } from "@/lib/media/autoHide.logic"

// The control bar of a running slideshow: a step either way, pause, where it is, the time per image, shuffle and
// (where the list is one directory's) subdirectories, and the end. Bottom-centred glass that hides with the cursor
// after CONTROLS_IDLE_MS; a pause, an open menu or keyboard focus on it keeps it.
export function SlideshowBar({
	slideshow,
	subfolders,
	onSubfoldersChange
}: {
	slideshow: Slideshow
	subfolders: { available: boolean; loading: boolean }
	onSubfoldersChange: (on: boolean) => void
}): ReactNode {
	const { t } = useTranslation(["preview", "audio"])
	const prefs = useSlideshowPrefs()
	const barRef = useRef<HTMLDivElement>(null)
	const [pointerActive, setPointerActive] = useState(false)
	const [keyboardFocus, setKeyboardFocus] = useState(false)
	const [menuOpen, setMenuOpen] = useState(false)
	const [idleTimer] = useState(() => new IdleTimer(setPointerActive, CONTROLS_IDLE_MS))
	const visible = controlsVisible({ paused: slideshow.paused, waiting: false, pointerActive, keyboardFocus, menuOpen, scrubbing: false })
	const { setMenuOpen: reportMenuOpen } = slideshow

	// The pointer is watched on the stage the bar sits on, which also loses its cursor while the bar is hidden.
	useEffect(() => {
		const stage = barRef.current?.parentElement

		if (stage === null || stage === undefined) {
			return
		}

		function poke(): void {
			idleTimer.poke()
		}

		function leave(event: PointerEvent): void {
			if (event.pointerType === "mouse") {
				idleTimer.idle()
			}
		}

		stage.addEventListener("pointermove", poke)
		stage.addEventListener("pointerdown", poke)
		stage.addEventListener("pointerleave", leave)
		idleTimer.poke()

		return () => {
			stage.removeEventListener("pointermove", poke)
			stage.removeEventListener("pointerdown", poke)
			stage.removeEventListener("pointerleave", leave)
			stage.classList.remove("cursor-none")
			idleTimer.stop()
		}
	}, [idleTimer])

	useEffect(() => {
		barRef.current?.parentElement?.classList.toggle("cursor-none", !visible)
	}, [visible])

	function handleMenuOpenChange(open: boolean): void {
		setMenuOpen(open)
		reportMenuOpen(open)
	}

	return (
		<div
			ref={barRef}
			role="group"
			aria-label={t("previewSlideshowControls")}
			className={cn(
				"absolute bottom-3 left-1/2 z-10 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-1 rounded-2xl px-2 py-1.5 transition-opacity duration-200 motion-reduce:transition-none",
				MEDIA_GLASS_SURFACE_CLASS,
				// Hidden, yet still in the tab order: a Tab onto a control brings the bar back.
				visible ? "opacity-100" : "pointer-events-none opacity-0"
			)}
			onFocus={event => {
				setKeyboardFocus(event.target.matches(":focus-visible"))
			}}
			onBlur={event => {
				if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
					setKeyboardFocus(false)
				}
			}}
		>
			<TooltipIconButton
				label={t("previewPreviousAction")}
				onClick={() => {
					slideshow.go(-1)
				}}
			>
				<SkipBackIcon />
			</TooltipIconButton>
			<TooltipIconButton
				label={slideshow.paused ? t("previewSlideshowResume") : t("audio:pause")}
				onClick={slideshow.togglePause}
			>
				{slideshow.paused ? <PlayIcon className="fill-current" /> : <PauseIcon className="fill-current" />}
			</TooltipIconButton>
			<TooltipIconButton
				label={t("previewNextAction")}
				onClick={() => {
					slideshow.go(1)
				}}
			>
				<SkipForwardIcon />
			</TooltipIconButton>
			<span className="min-w-12 shrink-0 px-1 text-center text-xs text-muted-foreground tabular-nums">
				{t("previewSlideshowPosition", { position: slideshow.position, total: slideshow.total })}
			</span>
			<DropdownMenu onOpenChange={handleMenuOpenChange}>
				<DropdownMenuTrigger
					render={
						<Button
							variant="ghost"
							size="sm"
							aria-label={t("previewSlideshowInterval")}
							className="px-2 tabular-nums"
						>
							{t("previewSlideshowIntervalValue", { count: prefs.intervalSeconds })}
						</Button>
					}
				/>
				<DropdownMenuContent
					side="top"
					align="center"
					// Over the picture, so it wears the controls' dark tone rather than the app's glass.
					className={cn(MEDIA_GLASS_TONE_CLASS, "w-auto min-w-32 before:backdrop-saturate-100")}
				>
					<DropdownMenuRadioGroup
						value={String(prefs.intervalSeconds)}
						onValueChange={(next: string) => {
							const seconds = SLIDESHOW_INTERVALS.find(option => String(option) === next)

							if (seconds !== undefined) {
								setSlideshowPrefs({ intervalSeconds: seconds })
							}
						}}
					>
						<DropdownMenuLabel>{t("previewSlideshowInterval")}</DropdownMenuLabel>
						{SLIDESHOW_INTERVALS.map(option => (
							<DropdownMenuRadioItem
								key={option}
								value={String(option)}
								// A choice, as in a select: picking one closes the menu.
								closeOnClick
							>
								{t("previewSlideshowIntervalValue", { count: option })}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
			<TooltipIconButton
				label={t("audio:shuffle")}
				pressed={prefs.shuffle}
				className={TOGGLE_ON_CLASS}
				onClick={() => {
					setSlideshowPrefs({ shuffle: !prefs.shuffle })
				}}
			>
				<ShuffleIcon />
			</TooltipIconButton>
			{subfolders.available ? (
				<TooltipIconButton
					label={t("previewSlideshowSubfolders")}
					pressed={prefs.subfolders}
					disabled={subfolders.loading}
					className={TOGGLE_ON_CLASS}
					onClick={() => {
						onSubfoldersChange(!prefs.subfolders)
					}}
				>
					<FoldersIcon />
				</TooltipIconButton>
			) : null}
			<TooltipIconButton
				label={t("previewSlideshowStop")}
				onClick={slideshow.stop}
			>
				<XIcon />
			</TooltipIconButton>
		</div>
	)
}
