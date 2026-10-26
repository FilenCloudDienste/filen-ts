import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import {
	ArrowLeftIcon,
	CircleHelpIcon,
	MaximizeIcon,
	MinimizeIcon,
	PauseIcon,
	PictureInPicture2Icon,
	PlayIcon,
	RotateCcwIcon,
	RotateCwIcon,
	SkipBackIcon,
	SkipForwardIcon
} from "lucide-react"
import type { CueStore } from "@filen/shared/videos"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { VolumeControl } from "@/components/media/volumeControl"
import { IdleTimer } from "@/lib/media/autoHide.logic"
import { isVideoNativeFullscreen, toggleVideoFullscreen, useIsFullscreen, videoFullscreenSupported } from "@/lib/media/fullscreen"
import { stepMediaVolume, toggleMediaMuted, warmMediaVolume } from "@/lib/media/mediaVolume"
import { playerKeyTarget } from "@/lib/media/playerKeys.logic"
import { SeekCoalescer } from "@/lib/media/seekCoalescer.logic"
import { chapterTarget, frameDuration, stepPlaybackRate, videoKeyAction, type VideoKeyAction } from "@/lib/media/videoKeys.logic"
import { useHoldReadsWhilePlaying } from "@/lib/media/useHoldReadsWhilePlaying"
import { seekMedia, setPlaybackRate, toggleMediaPlayback, useMediaPictureInPicture, useSyncedMediaVolume } from "@/lib/media/useMediaState"
import { useIsNarrowViewport } from "@/features/shell/hooks/useIsNarrowViewport"
import { StageIconButton } from "@/components/media/video/stageButton"
import { VideoStageContainerContext, VideoStagePopupContext } from "@/components/media/video/stageContext"
import { SubtitleOverlay } from "@/components/media/video/subtitleOverlay"
import { VideoScrubber } from "@/components/media/video/videoScrubber"
import { ShortcutsDialog } from "@/components/media/video/shortcutsDialog"
import { useStageWakeLock } from "@/components/media/video/useStageWakeLock"
import {
	DOUBLE_TAP_MS,
	STAGE_CONTROLS_IDLE_MS,
	STAGE_SPINNER_DELAY_MS,
	STAGE_STILL_LOADING_MS,
	doubleTapZone,
	stageControlsVisible,
	stallState,
	type StageChapter,
	type StallState
} from "@/components/media/video/stage.logic"

// The full-screen video stage: a black, always-dark layer above the app with the picture, gradient
// scrims, a top bar, a two-row bottom bar of ghost buttons and a full-width scrubber, and slots for the
// cards and panels a caller adds. No backdrop blur anywhere over the moving picture. The controls hide
// after 3 s untouched and stay in the tab order. One <video> element lives as long as the stage; callers
// swap what it plays.

export interface VideoStageProps {
	title: ReactNode
	backLabel: string
	onBack: () => void
	// The picture's accessible name.
	videoLabel: string
	onVideo: (video: HTMLVideoElement | null) => void
	chapters: readonly StageChapter[]
	// "Part 2 of 3" for a stacked item.
	partLabel?: string | null
	frameRate?: number | null
	cues: CueStore | null
	// Seconds, positive = later.
	cueOffset: number
	// The style panel's sample line over the picture.
	cueSample?: string | null
	// The element has nothing to show yet (opening, between items).
	loading: boolean
	onRetry?: (() => void) | undefined
	// Replaces the picture's controls (nothing plays: unsupported, failed).
	failure?: ReactNode
	hasNext: boolean
	hasPrevious: boolean
	onNext?: (() => void) | undefined
	onPrevious?: (() => void) | undefined
	nextLabel?: string | undefined
	previousLabel?: string | undefined
	// Buttons after next: episodes, tracks, settings. `phone` lays them out for the trimmed bar; their popups keep the
	// controls up through useStagePopupOpen.
	trailing: (layout: { phone: boolean }) => ReactNode
	cornerCard?: ReactNode
	centerCard?: ReactNode
	// Short messages at the top (resumed at, still loading, offline), read out through a status region that stays
	// mounted.
	notice?: ReactNode
	// Read out politely (Up Next): the live region stays mounted, so a change is announced.
	announcement?: string | null
	sidePanel?: ReactNode
	// A card or panel wants the controls up (blocking cards, open panels).
	holdControls: boolean
	// Screen actions first (skip, next, subtitles); returns true when handled.
	onAction: (action: VideoKeyAction) => boolean
	onControlsVisibleChange?: (visible: boolean) => void
	// The user touched a control (a key, a click on the bar): resets the still-watching count.
	onInteraction?: () => void
}

function pictureInPictureSupported(): boolean {
	return typeof document !== "undefined" && "pictureInPictureEnabled" in document && document.pictureInPictureEnabled
}

function togglePictureInPicture(video: HTMLVideoElement): void {
	if (document.pictureInPictureElement === video) {
		void document.exitPictureInPicture().catch(() => undefined)
	} else {
		void video.requestPictureInPicture().catch(() => undefined)
	}
}

export function VideoStage(props: VideoStageProps) {
	const { t } = useTranslation("videos")
	const [container, setContainer] = useState<HTMLDivElement | null>(null)
	const [video, setVideo] = useState<HTMLVideoElement | null>(null)
	const [paused, setPaused] = useState(true)
	const [stall, setStall] = useState<StallState>("none")
	const [pointerActive, setPointerActive] = useState(false)
	const [keyboardFocus, setKeyboardFocus] = useState(false)
	const [popupCount, setPopupCount] = useState(0)
	const [scrubbing, setScrubbing] = useState(false)
	const [pendingSeek, setPendingSeek] = useState<number | null>(null)
	const [remainingMode, setRemainingMode] = useState(true)
	const [shortcutsOpen, setShortcutsOpen] = useState(false)
	const [ripple, setRipple] = useState<{ side: -1 | 1; at: number } | null>(null)
	const [idleTimer] = useState(() => new IdleTimer(setPointerActive, STAGE_CONTROLS_IDLE_MS))
	const lastTap = useRef<{ at: number; zone: -1 | 0 | 1 } | null>(null)
	const lastPointerType = useRef("mouse")
	const videoRef = useRef<HTMLVideoElement | null>(null)
	const phone = useIsNarrowViewport()
	const fullscreen = useIsFullscreen(container)
	const pictureInPicture = useMediaPictureInPicture(video)
	const { onVideo, onControlsVisibleChange, onAction, onInteraction } = props
	const popupOpen = popupCount > 0 || shortcutsOpen
	const visible = stageControlsVisible({
		paused,
		waiting: stall !== "none" || props.loading,
		pointerActive,
		keyboardFocus,
		popupOpen,
		scrubbing,
		blocking: props.holdControls
	})
	const coalescerRef = useRef<SeekCoalescer | null>(null)

	useSyncedMediaVolume(video)
	useHoldReadsWhilePlaying(video)
	useStageWakeLock(video)

	useEffect(() => {
		void warmMediaVolume()
	}, [])

	useEffect(() => {
		onControlsVisibleChange?.(visible)
	}, [visible, onControlsVisibleChange])

	// Play state and stalls, from the element's events. A stall shows a spinner only after 400 ms, and says
	// "still loading" after 15 s.
	useEffect(() => {
		if (video === null) {
			return
		}

		const element = video
		let spinnerTimer: ReturnType<typeof setTimeout> | null = null
		let slowTimer: ReturnType<typeof setTimeout> | null = null

		function clearTimers(): void {
			if (spinnerTimer !== null) {
				clearTimeout(spinnerTimer)
				spinnerTimer = null
			}

			if (slowTimer !== null) {
				clearTimeout(slowTimer)
				slowTimer = null
			}
		}

		function stalled(): boolean {
			return element.seeking || (!element.paused && element.readyState < HTMLMediaElement.HAVE_FUTURE_DATA)
		}

		function update(): void {
			setPaused(element.paused)

			if (!stalled()) {
				clearTimers()
				setStall("none")

				return
			}

			if (spinnerTimer === null && slowTimer === null) {
				const since = performance.now()

				spinnerTimer = setTimeout(() => {
					spinnerTimer = null
					setStall(stallState(performance.now() - since))
				}, STAGE_SPINNER_DELAY_MS)
				slowTimer = setTimeout(() => {
					slowTimer = null
					setStall(stallState(performance.now() - since))
				}, STAGE_STILL_LOADING_MS)
			}
		}

		const events = ["play", "pause", "playing", "waiting", "seeking", "seeked", "canplay", "loadeddata", "emptied", "ended"]

		update()

		for (const event of events) {
			element.addEventListener(event, update)
		}

		return () => {
			clearTimers()

			for (const event of events) {
				element.removeEventListener(event, update)
			}
		}
	}, [video])

	// Playback starting shows the controls for one idle period before they fade.
	useEffect(() => {
		if (video === null) {
			return
		}

		function handlePlay(): void {
			idleTimer.poke()
		}

		video.addEventListener("play", handlePlay)

		return () => {
			video.removeEventListener("play", handlePlay)
			idleTimer.stop()
		}
	}, [video, idleTimer])

	useEffect(() => {
		if (ripple === null) {
			return
		}

		const timer = setTimeout(() => {
			setRipple(null)
		}, 500)

		return () => {
			clearTimeout(timer)
		}
	}, [ripple])

	// The element outlives every item; a pending keyboard seek doesn't: one still waiting when the element is
	// emptied (the next item, a restart) is dropped rather than landing on what plays next.
	useEffect(() => {
		if (video === null) {
			return
		}

		function cancel(): void {
			coalescerRef.current?.cancel()
		}

		video.addEventListener("emptied", cancel)
		video.addEventListener("loadstart", cancel)

		return () => {
			video.removeEventListener("emptied", cancel)
			video.removeEventListener("loadstart", cancel)
			cancel()
		}
	}, [video])

	// Keyboard and button seeks, coalesced; made on first use (event handlers only). Not `??=`, which the React
	// Compiler can't compile yet.
	function coalescer(): SeekCoalescer {
		const existing = coalescerRef.current

		if (existing !== null) {
			return existing
		}

		const made = new SeekCoalescer({
			current: () => videoRef.current?.currentTime ?? 0,
			duration: () => {
				const duration = videoRef.current?.duration ?? 0

				return Number.isFinite(duration) && duration > 0 ? duration : 0
			},
			seek: seconds => {
				const element = videoRef.current

				if (element !== null) {
					seekMedia(element, seconds)
				}
			},
			onPending: setPendingSeek,
			now: () => performance.now(),
			setTimer: (callback, ms) => setTimeout(callback, ms),
			clearTimer: timer => {
				clearTimeout(timer)
			}
		})

		coalescerRef.current = made

		return made
	}

	// The stage takes the keyboard when it opens, and keeps the app behind it out of reach (focus, clicks,
	// assistive technology) while it is up.
	useEffect(() => {
		// A card that mounted with the stage (a failure) already took it.
		if (container !== null && !container.contains(document.activeElement)) {
			container.focus({ preventScroll: true })
		}
	}, [container])

	useEffect(() => {
		const root = document.getElementById("root")

		if (root === null || root.inert) {
			return
		}

		root.inert = true

		return () => {
			root.inert = false
		}
	}, [])

	function attachVideo(element: HTMLVideoElement | null): void {
		if (element !== null) {
			// Before any source is attached: ManagedMediaSource never opens otherwise.
			element.disableRemotePlayback = true
		}

		videoRef.current = element
		setVideo(element)
		onVideo(element)
	}

	function handlePopupChange(delta: 1 | -1): void {
		setPopupCount(count => Math.max(0, count + delta))
	}

	function seekBy(seconds: number): void {
		coalescer().seekBy(seconds)
	}

	function seekTo(seconds: number): void {
		coalescerRef.current?.cancel()

		if (video !== null) {
			seekMedia(video, seconds)
		}
	}

	function chapter(direction: 1 | -1): void {
		if (video === null) {
			return
		}

		const target = chapterTarget(
			props.chapters.map(entry => entry.start),
			coalescer().target(),
			direction
		)

		if (target !== null) {
			seekTo(target)
		}
	}

	function toggleFullscreenNow(): void {
		if (container !== null && video !== null) {
			void toggleVideoFullscreen(container, video).catch(() => undefined)
		}
	}

	// The stage's own handling of a key's action, after the caller had its chance.
	function runAction(action: VideoKeyAction): boolean {
		if (onAction(action)) {
			return true
		}

		if (video === null) {
			return false
		}

		switch (action.type) {
			case "togglePlay":
			case "confirm":
				toggleMediaPlayback(video)

				return true
			case "seekBy":
				seekBy(action.seconds)

				return true
			case "seekToFraction":
				seekTo(Number.isFinite(video.duration) ? video.duration * action.fraction : 0)

				return true
			case "seekToStart":
				seekTo(0)

				return true
			case "seekToEnd":
				seekTo(Number.isFinite(video.duration) ? video.duration : 0)

				return true
			case "chapter":
				chapter(action.direction)

				return true
			case "frameStep":
				if (!video.paused) {
					video.pause()
				}

				seekTo(video.currentTime + action.direction * frameDuration(props.frameRate ?? null))

				return true
			case "volumeBy":
				stepMediaVolume(action.delta)

				return true
			case "toggleMute":
				toggleMediaMuted()

				return true
			case "toggleFullscreen":
				toggleFullscreenNow()

				return true
			case "rate":
				setPlaybackRate(video, stepPlaybackRate(video.playbackRate, action.direction))

				return true
			case "togglePictureInPicture":
				if (pictureInPictureSupported()) {
					togglePictureInPicture(video)
				}

				return true
			case "shortcuts":
				setShortcutsOpen(true)

				return true
			case "next":
				props.onNext?.()

				return props.onNext !== undefined
			case "previous":
				props.onPrevious?.()

				return props.onPrevious !== undefined
			default:
				return false
		}
	}

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		// A popup's own keys (its Escape included) are its own: Base UI closes it.
		if (event.defaultPrevented || (event.target instanceof Element && event.target.closest("[data-stage-popup]") !== null)) {
			return
		}

		const action = videoKeyAction({
			key: event.key,
			target: playerKeyTarget(event.target),
			modified: event.ctrlKey || event.metaKey || event.altKey,
			shift: event.shiftKey
		})

		if (action === null || !runAction(action)) {
			return
		}

		event.preventDefault()
		event.stopPropagation()
		onInteraction?.()

		if (action.type !== "dismiss") {
			idleTimer.poke()
		}
	}

	function handleSurfacePointerUp(event: PointerEvent<HTMLDivElement>): void {
		if (video === null) {
			return
		}

		if (event.pointerType === "mouse") {
			if (event.button === 0) {
				toggleMediaPlayback(video)
				onInteraction?.()
			}

			return
		}

		// Touch: a tap shows or hides the controls; a double tap on a side third seeks.
		const rect = event.currentTarget.getBoundingClientRect()
		const zone = doubleTapZone(event.clientX - rect.left, rect.width)
		const now = performance.now()
		const previous = lastTap.current

		if (previous !== null && now - previous.at < DOUBLE_TAP_MS && previous.zone === zone && zone !== 0) {
			lastTap.current = null
			seekBy(zone * 10)
			setRipple({ side: zone, at: now })
			idleTimer.poke()
			onInteraction?.()

			return
		}

		lastTap.current = { at: now, zone }

		if (visible && !paused) {
			idleTimer.idle()
		} else {
			idleTimer.poke()
		}
	}

	// A control reached by keyboard keeps the controls up; the stage itself (focused on open and when a card or
	// panel closes) doesn't, or they would never hide after a keyboard start.
	function handleFocus(event: FocusEvent<HTMLDivElement>): void {
		setKeyboardFocus(event.target !== event.currentTarget && event.target.matches(":focus-visible"))
	}

	function handleBlur(event: FocusEvent<HTMLDivElement>): void {
		if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
			setKeyboardFocus(false)
		}
	}

	const nativeFullscreen = video !== null && isVideoNativeFullscreen(video)
	const playLabel = paused ? t("playerPlay") : t("playerPause")
	const controlsClass = cn(
		"transition-opacity duration-200 motion-reduce:transition-none",
		visible ? "opacity-100" : "pointer-events-none opacity-0"
	)

	const stage = (
		<div
			ref={setContainer}
			// A modal layer over the app: the app's own shortcuts stand down while it is open (dialogGuard).
			role="dialog"
			aria-modal="true"
			data-open=""
			aria-label={props.videoLabel}
			tabIndex={-1}
			className={cn(
				"dark fixed inset-0 z-50 flex overflow-hidden bg-black text-foreground [color-scheme:dark] outline-none select-none",
				!visible && "cursor-none"
			)}
			onKeyDown={handleKeyDown}
			onPointerMove={event => {
				if (event.pointerType === "mouse") {
					idleTimer.poke()
				}
			}}
			onPointerLeave={event => {
				if (event.pointerType === "mouse") {
					idleTimer.idle()
				}
			}}
			onFocus={handleFocus}
			onBlur={handleBlur}
		>
			<VideoStageContainerContext.Provider value={container}>
				<VideoStagePopupContext.Provider value={handlePopupChange}>
					<div className="relative min-w-0 flex-1">
						<video
							ref={attachVideo}
							aria-label={props.videoLabel}
							playsInline
							preload="metadata"
							// No cast or AirPlay: files are decrypted in this browser only.
							x-webkit-airplay="deny"
							controlsList="nodownload noremoteplayback"
							className="absolute inset-0 size-full object-contain"
							onContextMenu={event => {
								event.preventDefault()
							}}
						/>
						<SubtitleOverlay
							video={video}
							cues={props.cues}
							offset={props.cueOffset}
							sample={props.cueSample}
							raised={visible && props.failure === undefined}
						/>
						{/* The picture's own click target: play/pause with a mouse, show/hide and double-tap seek by touch. */}
						<div
							aria-hidden="true"
							className="absolute inset-0"
							onPointerUp={handleSurfacePointerUp}
							onPointerDown={event => {
								lastPointerType.current = event.pointerType
							}}
							onDoubleClick={() => {
								if (lastPointerType.current === "mouse") {
									toggleFullscreenNow()
								}
							}}
						/>
						{ripple === null ? null : (
							<div
								aria-hidden="true"
								className={cn(
									"pointer-events-none absolute inset-y-0 flex w-1/3 animate-out items-center justify-center bg-white/10 text-sm font-medium text-white duration-500 fade-out-0",
									ripple.side < 0 ? "left-0 rounded-r-[50%]" : "right-0 rounded-l-[50%]"
								)}
							>
								{ripple.side < 0 ? t("playerSeekBackShort") : t("playerSeekForwardShort")}
							</div>
						)}
						{/* Scrims: plain gradients, nothing blurred. */}
						<div
							aria-hidden="true"
							className={cn(
								"pointer-events-none absolute inset-x-0 top-0 h-36 bg-linear-to-b from-black/75 to-transparent",
								controlsClass
							)}
						/>
						<div
							aria-hidden="true"
							className={cn(
								"pointer-events-none absolute inset-x-0 bottom-0 h-52 bg-linear-to-t from-black/85 via-black/45 to-transparent",
								controlsClass
							)}
						/>
						<div
							className={cn(
								"absolute inset-x-0 top-0 flex items-center gap-2 px-3 pt-[calc(max(0.75rem,env(safe-area-inset-top))+var(--window-inset-top))] pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left),var(--window-inset-left))]",
								controlsClass,
								// Desktop window chrome only while shown: hidden, the picture's top edge takes the click.
								visible && "app-region-chrome"
							)}
						>
							<StageIconButton
								label={props.backLabel}
								onClick={props.onBack}
							>
								<ArrowLeftIcon className="size-5" />
							</StageIconButton>
							<h1 className="min-w-0 flex-1 truncate text-sm font-medium text-white sm:text-base">{props.title}</h1>
							<StageIconButton
								label={t("playerShortcuts")}
								shortcut="?"
								onClick={() => {
									setShortcutsOpen(true)
								}}
							>
								<CircleHelpIcon className="size-5" />
							</StageIconButton>
						</div>
						{/* Always mounted: a status region inserted with its text is not read out. */}
						<div
							role="status"
							aria-atomic="true"
							className="pointer-events-none absolute inset-x-0 top-16 flex justify-center px-4 [&>*]:pointer-events-auto"
						>
							{props.notice}
						</div>
						{props.failure !== undefined && props.failure !== null ? (
							<div className="absolute inset-0 flex items-center justify-center p-6">{props.failure}</div>
						) : (
							<>
								{stall !== "none" || props.loading ? (
									<div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3">
										<StageSpinner />
										{stall === "stillLoading" ? (
											<div className="pointer-events-auto flex flex-col items-center gap-2 text-sm text-white">
												<p>{t("playerStillLoading")}</p>
												{props.onRetry === undefined ? null : (
													<Button
														variant="secondary"
														size="sm"
														onClick={props.onRetry}
													>
														{t("playerRetry")}
													</Button>
												)}
											</div>
										) : null}
									</div>
								) : null}
								{phone ? (
									<div
										className={cn(
											"pointer-events-none absolute inset-0 flex items-center justify-center gap-10",
											controlsClass
										)}
									>
										<CenterButton
											shown={visible}
											label={t("playerSeekBack")}
											onClick={() => {
												seekBy(-10)
												onInteraction?.()
											}}
										>
											<RotateCcwIcon className="size-7" />
										</CenterButton>
										<CenterButton
											shown={visible}
											label={playLabel}
											large
											onClick={() => {
												if (video !== null) {
													toggleMediaPlayback(video)
													onInteraction?.()
												}
											}}
										>
											{paused ? (
												<PlayIcon className="size-9 translate-x-0.5 fill-current" />
											) : (
												<PauseIcon className="size-9 fill-current" />
											)}
										</CenterButton>
										<CenterButton
											shown={visible}
											label={t("playerSeekForward")}
											onClick={() => {
												seekBy(10)
												onInteraction?.()
											}}
										>
											<RotateCwIcon className="size-7" />
										</CenterButton>
									</div>
								) : null}
								<div
									role="group"
									aria-label={t("playerControls")}
									className={cn(
										"absolute inset-x-0 bottom-0 flex flex-col gap-1 px-3 pr-[max(0.75rem,env(safe-area-inset-right))] pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] sm:px-5",
										controlsClass
									)}
									onPointerDown={() => {
										onInteraction?.()
									}}
								>
									<VideoScrubber
										video={video}
										visible={visible}
										chapters={props.chapters}
										pendingTarget={pendingSeek}
										remainingMode={remainingMode}
										label={t("playerSeek")}
										partLabel={props.partLabel}
										onSeek={seconds => {
											seekTo(seconds)
										}}
										onSeekBy={seekBy}
										onChapter={chapter}
										onScrub={setScrubbing}
										onToggleRemaining={() => {
											setRemainingMode(mode => !mode)
										}}
									/>
									<div className="flex items-center gap-0.5 sm:gap-1">
										<StageIconButton
											label={playLabel}
											shortcut="K"
											onClick={() => {
												if (video !== null) {
													toggleMediaPlayback(video)
												}
											}}
										>
											{paused ? (
												<PlayIcon className="size-5 fill-current" />
											) : (
												<PauseIcon className="size-5 fill-current" />
											)}
										</StageIconButton>
										{phone ? null : (
											<>
												<StageIconButton
													label={t("playerSeekBack")}
													shortcut="J"
													onClick={() => {
														seekBy(-10)
													}}
												>
													<RotateCcwIcon className="size-5" />
												</StageIconButton>
												<StageIconButton
													label={t("playerSeekForward")}
													shortcut="L"
													onClick={() => {
														seekBy(10)
													}}
												>
													<RotateCwIcon className="size-5" />
												</StageIconButton>
												<VolumeControl
													className="ml-1"
													sliderClassName="max-lg:hidden"
												/>
											</>
										)}
										<div className="flex-1" />
										{!phone && props.hasPrevious ? (
											<StageIconButton
												label={props.previousLabel ?? t("playerPrevious")}
												shortcut="⇧P"
												onClick={props.onPrevious}
											>
												<SkipBackIcon className="size-5 fill-current" />
											</StageIconButton>
										) : null}
										{!phone && props.hasNext ? (
											<StageIconButton
												label={props.nextLabel ?? t("playerNext")}
												shortcut="⇧N"
												onClick={props.onNext}
											>
												<SkipForwardIcon className="size-5 fill-current" />
											</StageIconButton>
										) : null}
										{props.trailing({ phone })}
										{!phone && pictureInPictureSupported() ? (
											<StageIconButton
												label={pictureInPicture ? t("playerExitPictureInPicture") : t("playerPictureInPicture")}
												shortcut="I"
												pressed={pictureInPicture}
												onClick={() => {
													if (video !== null) {
														togglePictureInPicture(video)
													}
												}}
											>
												<PictureInPicture2Icon className="size-5" />
											</StageIconButton>
										) : null}
										{videoFullscreenSupported(video) ? (
											<StageIconButton
												label={fullscreen || nativeFullscreen ? t("playerExitFullscreen") : t("playerFullscreen")}
												shortcut="F"
												onClick={toggleFullscreenNow}
											>
												{fullscreen ? <MinimizeIcon className="size-5" /> : <MaximizeIcon className="size-5" />}
											</StageIconButton>
										) : null}
									</div>
								</div>
							</>
						)}
						{props.cornerCard === undefined || props.cornerCard === null ? null : (
							<div
								className={cn(
									"absolute right-[max(1rem,env(safe-area-inset-right))] transition-[bottom] duration-200 motion-reduce:transition-none",
									visible ? "bottom-32" : "bottom-8"
								)}
								onPointerDown={() => {
									onInteraction?.()
								}}
							>
								{props.cornerCard}
							</div>
						)}
						{props.centerCard === undefined || props.centerCard === null ? null : (
							<div
								className="absolute inset-0 flex items-center justify-center bg-black/50 p-4"
								onPointerDown={() => {
									onInteraction?.()
								}}
							>
								{props.centerCard}
							</div>
						)}
					</div>
					{props.sidePanel}
					<ShortcutsDialog
						open={shortcutsOpen}
						onOpenChange={setShortcutsOpen}
					/>
					<p
						aria-live="polite"
						className="sr-only"
					>
						{props.announcement ?? ""}
					</p>
				</VideoStagePopupContext.Provider>
			</VideoStageContainerContext.Provider>
		</div>
	)

	return createPortal(stage, document.body)
}

function StageSpinner() {
	return (
		<div className="flex size-14 items-center justify-center rounded-full bg-black/60 ring-1 ring-white/15">
			<Spinner className="size-6 text-white" />
		</div>
	)
}

// Takes the pointer only while the controls show: a tap on hidden controls reaches the picture (which shows
// them), and a double tap on a side third seeks instead of pressing a button nobody sees.
function CenterButton({
	label,
	large,
	shown,
	onClick,
	children
}: {
	label: string
	large?: boolean
	shown: boolean
	onClick: () => void
	children: ReactNode
}) {
	return (
		<button
			type="button"
			aria-label={label}
			className={cn(
				"flex items-center justify-center rounded-full bg-black/45 text-white ring-1 ring-white/15 outline-none focus-visible:ring-3 focus-visible:ring-white/60 active:scale-95 motion-reduce:transition-none",
				shown ? "pointer-events-auto" : "pointer-events-none",
				large === true ? "size-20" : "size-14"
			)}
			onClick={onClick}
		>
			{children}
		</button>
	)
}
