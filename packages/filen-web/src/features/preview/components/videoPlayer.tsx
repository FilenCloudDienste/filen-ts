import { useEffect, useRef, useState, type FocusEvent, type MouseEvent, type PointerEvent } from "react"
import { useTranslation } from "react-i18next"
import { MaximizeIcon, MinimizeIcon, PauseIcon, PictureInPicture2Icon, PlayIcon, XIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { MediaElementScrubber } from "@/components/media/mediaScrubber"
import { MediaCurrentTime, MediaDuration } from "@/components/media/mediaTime"
import { VolumeControl } from "@/components/media/volumeControl"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { Spinner } from "@/components/ui/spinner"
import { MEDIA_GLASS_SURFACE_CLASS, MEDIA_GLASS_TONE_CLASS } from "@/components/ui/surface"
import { CONTROLS_IDLE_MS, controlsVisible, IdleTimer } from "@/lib/media/autoHide.logic"
import { fullscreenSupported, toggleFullscreen, useIsFullscreen } from "@/lib/media/fullscreen"
import { warmMediaVolume } from "@/lib/media/mediaVolume"
import { handlePlayerKeyDown } from "@/lib/media/playerKeyboard"
import {
	mediaValue,
	playMedia,
	seekMedia,
	setPlaybackRate,
	toggleMediaPlayback,
	useMediaPaused,
	useMediaPictureInPicture,
	useMediaPlaybackRate,
	useMediaValue,
	useMediaWaiting,
	useSyncedMediaVolume
} from "@/lib/media/useMediaState"
import { reportMediaFailure, type MediaFailureKind } from "@/lib/media/mediaFailure"
import type { BlockSource } from "@/lib/media/blockSource"
import { mediaControlsList } from "@/features/preview/lib/accessMode"
import { getVideoPosition, setVideoPosition } from "@/features/preview/lib/videoContinuity"
import { CODECS, type CodecId } from "@/features/preview/lib/containerTracks"
import { usePlaybackGap } from "@/features/preview/hooks/usePlaybackGap"
import { MediaFailureState } from "@/features/preview/components/mediaFailureState"
import { PreviewDownloadButton } from "@/features/preview/components/previewErrorState"

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const

const HAS_METADATA = mediaValue(
	["loadedmetadata", "emptied"],
	(media: HTMLMediaElement) => media.readyState >= HTMLMediaElement.HAVE_METADATA
)

// Width over height; 0 until the element knows its frame size.
const ASPECT_RATIO = mediaValue(["loadedmetadata", "resize", "emptied"], (media: HTMLMediaElement) =>
	media instanceof HTMLVideoElement && media.videoWidth > 0 && media.videoHeight > 0 ? media.videoWidth / media.videoHeight : 0
)

// The picture box before the frame size is known.
const DEFAULT_ASPECT_RATIO = 16 / 9

function pictureInPictureSupported(): boolean {
	return typeof document !== "undefined" && "pictureInPictureEnabled" in document && document.pictureInPictureEnabled
}

// Restores where this item was left within the overlay session (videoContinuity.ts) and autoplays once
// metadata is in, after the shared volume is known so playback never starts at the wrong level. A
// refused play() (an autoplay policy) leaves the element paused behind the big play button.
function useVideoContinuity(video: HTMLVideoElement | null, positionKey: string): void {
	useEffect(() => {
		if (video === null) {
			return
		}

		const element = video
		let live = true

		function restoreAndPlay(): void {
			const saved = getVideoPosition(positionKey)

			if (saved !== undefined) {
				seekMedia(element, saved)
			}

			void warmMediaVolume().then(() => {
				if (live) {
					playMedia(element)
				}
			})
		}

		// Metadata may already be in (a cached response), and its event will not fire again.
		if (element.readyState >= HTMLMediaElement.HAVE_METADATA) {
			restoreAndPlay()
		} else {
			element.addEventListener("loadedmetadata", restoreAndPlay, { once: true })
		}

		function handlePause(): void {
			setVideoPosition(positionKey, element.currentTime)
		}

		element.addEventListener("pause", handlePause)

		return () => {
			live = false
			element.removeEventListener("loadedmetadata", restoreAndPlay)
			element.removeEventListener("pause", handlePause)
			// Stepping away mid-playback fires no pause.
			setVideoPosition(positionKey, element.currentTime)
		}
	}, [video, positionKey])
}

// The preview's video player: our own controls on a glass bar floating over the picture, hidden while
// playback runs untouched. Loops, like the rest of the full preview experience; a chat's inline embed
// keeps the browser's controls.
export function VideoPlayer({
	url,
	alt,
	downloadable,
	onError,
	positionKey,
	source
}: {
	url: string
	alt: string
	downloadable: boolean
	onError?: (() => void) | undefined
	positionKey: string
	// The same file's bytes, read to tell a format failure from a broken stream and to name a codec.
	source: BlockSource
}) {
	const { t } = useTranslation(["preview", "audio"])
	const [container, setContainer] = useState<HTMLDivElement | null>(null)
	const [video, setVideo] = useState<HTMLVideoElement | null>(null)
	const paused = useMediaPaused(video)
	const waiting = useMediaWaiting(video)
	const hasMetadata = useMediaValue(video, HAS_METADATA, false)
	const aspectRatio = useMediaValue(video, ASPECT_RATIO, 0) || DEFAULT_ASPECT_RATIO
	const [failure, setFailure] = useState<MediaFailureKind | null>(null)
	const gap = usePlaybackGap(video, source)
	const [gapDismissed, setGapDismissed] = useState(false)
	const [pointerActive, setPointerActive] = useState(false)
	const [keyboardFocus, setKeyboardFocus] = useState(false)
	const [menuOpen, setMenuOpen] = useState(false)
	const [scrubbing, setScrubbing] = useState(false)
	const [idleTimer] = useState(() => new IdleTimer(setPointerActive, CONTROLS_IDLE_MS))
	// A tap on the picture while the controls are hidden only brings them back; it does not also pause.
	const tapRevealsControls = useRef(false)
	const fullscreen = useIsFullscreen(container)
	const loading = failure === null && (!hasMetadata || waiting)
	const visible = controlsVisible({ paused, waiting: loading, pointerActive, keyboardFocus, menuOpen, scrubbing })

	useSyncedMediaVolume(video)
	useVideoContinuity(video, positionKey)

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

	function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
		// Read before the poke below shows the controls.
		tapRevealsControls.current = event.pointerType === "touch" && !visible
		idleTimer.poke()
	}

	function handleSurfaceClick(event: MouseEvent<HTMLVideoElement>): void {
		if (tapRevealsControls.current) {
			tapRevealsControls.current = false

			return
		}

		toggleMediaPlayback(event.currentTarget)
	}

	function handleFocus(event: FocusEvent<HTMLDivElement>): void {
		setKeyboardFocus(event.target.matches(":focus-visible"))
	}

	function handleBlur(event: FocusEvent<HTMLDivElement>): void {
		if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
			setKeyboardFocus(false)
		}
	}

	return (
		<div className="relative size-full p-4">
			{failure !== null && video !== null ? (
				<div className="absolute inset-0">
					<MediaFailureState
						kind={failure}
						media={video}
						source={source}
					/>
				</div>
			) : null}
			{/* A size container, so the picture box below can fit itself to both of its dimensions. Hidden, not
			unmounted, once playback failed: a fresh element would only load and fail again. */}
			<div className={cn("[container-type:size] flex size-full items-center justify-center", failure !== null && "invisible")}>
				<div
					ref={setContainer}
					// Takes its own clicks and arrow keys, so the preview overlay neither toggles its chrome nor pages.
					data-preview-surface=""
					className={cn(
						"relative flex items-center justify-center overflow-hidden [&:-webkit-full-screen]:bg-black [&:fullscreen]:bg-black",
						!visible && "cursor-none"
					)}
					// Exactly the rendered picture, so the controls never float over letterboxing. Fullscreen's own
					// rules override the size and fill the screen.
					style={{ aspectRatio, width: `min(100cqw, calc(100cqh * ${String(aspectRatio)}))` }}
					onPointerMove={() => {
						idleTimer.poke()
					}}
					onPointerDown={handlePointerDown}
					onPointerLeave={event => {
						if (event.pointerType === "mouse") {
							idleTimer.idle()
						}
					}}
					onKeyDown={event => {
						if (handlePlayerKeyDown(event, video, container)) {
							idleTimer.poke()
						}
					}}
					onFocus={handleFocus}
					onBlur={handleBlur}
				>
					<video
						ref={setVideo}
						src={url}
						aria-label={alt}
						// Also drops the native context menu's own download entry.
						controlsList={mediaControlsList(downloadable)}
						loop
						playsInline
						preload="metadata"
						// Focusable, so a click on the picture hands the player the keyboard.
						tabIndex={-1}
						className="size-full object-contain outline-none"
						onClick={handleSurfaceClick}
						onContextMenu={
							downloadable
								? undefined
								: event => {
										event.preventDefault()
									}
						}
						// The streamed path recovers from a broken stream through onError; a format failure, and
						// anything on the buffered path, stays here.
						onError={event => {
							reportMediaFailure(event.currentTarget, source, kind => {
								if (kind === "other" && onError !== undefined) {
									onError()
								} else {
									setFailure(kind)
								}
							})
						}}
					/>
					{gap !== null && !gapDismissed ? (
						<PlaybackGapNotice
							codec={gap}
							onDismiss={() => {
								setGapDismissed(true)
							}}
						/>
					) : null}
					{failure !== null ? null : loading ? (
						<div
							className={cn(
								"pointer-events-none absolute flex size-14 items-center justify-center rounded-full",
								MEDIA_GLASS_SURFACE_CLASS
							)}
						>
							<Spinner className="size-6" />
						</div>
					) : paused ? (
						<button
							type="button"
							aria-label={t("audio:play")}
							className={cn(
								"absolute flex size-16 items-center justify-center rounded-full transition-transform duration-150 outline-none hover:scale-105 focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none",
								MEDIA_GLASS_SURFACE_CLASS
							)}
							onClick={() => {
								if (video !== null) {
									playMedia(video)
								}
							}}
						>
							<PlayIcon className="size-7 translate-x-0.5 fill-current" />
						</button>
					) : null}
					<div
						role="group"
						aria-label={t("previewMediaControls")}
						className={cn(
							"@container absolute inset-x-3 bottom-3 mx-auto flex max-w-4xl items-center gap-1 rounded-2xl px-2 py-1.5 transition-opacity duration-200 motion-reduce:transition-none",
							MEDIA_GLASS_SURFACE_CLASS,
							// Hidden, yet still in the tab order: a Tab onto a control brings the bar back.
							visible ? "opacity-100" : "pointer-events-none opacity-0"
						)}
					>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={paused ? t("audio:play") : t("audio:pause")}
							onClick={() => {
								if (video !== null) {
									toggleMediaPlayback(video)
								}
							}}
						>
							{paused ? <PlayIcon className="fill-current" /> : <PauseIcon className="fill-current" />}
						</Button>
						<MediaCurrentTime
							media={video}
							className="min-w-9 text-right"
						/>
						<MediaElementScrubber
							media={video}
							label={t("audio:seek")}
							onScrub={seconds => {
								setScrubbing(seconds !== null)
							}}
							className="mx-2 flex-1"
						/>
						<MediaDuration
							media={video}
							className="min-w-9"
						/>
						<VolumeControl sliderClassName="@max-md:hidden" />
						<PlaybackSpeedMenu
							media={video}
							// Only a fullscreen player needs the menu inside it; elsewhere it portals as usual.
							container={fullscreen ? container : null}
							onOpenChange={setMenuOpen}
						/>
						{pictureInPictureSupported() ? <PictureInPictureButton video={video} /> : null}
						{fullscreenSupported() ? (
							<FullscreenButton
								container={container}
								fullscreen={fullscreen}
							/>
						) : null}
					</div>
				</div>
			</div>
		</div>
	)
}

function PlaybackSpeedMenu({
	media,
	container,
	onOpenChange
}: {
	media: HTMLMediaElement | null
	container: HTMLElement | null
	onOpenChange: (open: boolean) => void
}) {
	const { t } = useTranslation("preview")
	const rate = useMediaPlaybackRate(media)
	const rateLabel = t("previewMediaSpeedRate", { rate })

	return (
		<DropdownMenu onOpenChange={onOpenChange}>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="sm"
						aria-label={t("previewMediaPlaybackSpeedLabel", { rate: rateLabel })}
						className="px-2 tabular-nums @max-xs:hidden"
					>
						{rateLabel}
					</Button>
				}
			/>
			<DropdownMenuContent
				side="top"
				align="end"
				container={container ?? undefined}
				// The menu opens over the picture, so it wears the controls' dark tone rather than the app's glass.
				className={cn(MEDIA_GLASS_TONE_CLASS, "w-auto min-w-36 before:backdrop-saturate-100")}
			>
				<DropdownMenuRadioGroup
					value={String(rate)}
					onValueChange={(next: string) => {
						if (media !== null) {
							setPlaybackRate(media, Number(next))
						}
					}}
				>
					<DropdownMenuLabel>{t("previewMediaPlaybackSpeed")}</DropdownMenuLabel>
					{PLAYBACK_RATES.map(option => (
						<DropdownMenuRadioItem
							key={option}
							value={String(option)}
						>
							{option === 1 ? t("previewMediaNormalSpeed") : t("previewMediaSpeedRate", { rate: option })}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function PictureInPictureButton({ video }: { video: HTMLVideoElement | null }) {
	const { t } = useTranslation("preview")
	const active = useMediaPictureInPicture(video)

	return (
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label={active ? t("previewMediaExitPictureInPicture") : t("previewMediaPictureInPicture")}
			aria-pressed={active}
			className="@max-sm:hidden"
			onClick={() => {
				if (video === null) {
					return
				}

				if (active) {
					void document.exitPictureInPicture().catch(() => undefined)
				} else {
					void video.requestPictureInPicture().catch(() => undefined)
				}
			}}
		>
			<PictureInPicture2Icon />
		</Button>
	)
}

function FullscreenButton({ container, fullscreen }: { container: HTMLElement | null; fullscreen: boolean }) {
	const { t } = useTranslation("preview")

	return (
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label={fullscreen ? t("previewMediaExitFullscreen") : t("previewMediaFullscreen")}
			onClick={() => {
				if (container !== null) {
					void toggleFullscreen(container).catch(() => undefined)
				}
			}}
		>
			{fullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
		</Button>
	)
}

// Over a video that plays without its sound or its picture: names the codec the browser cannot decode,
// offers the file instead, and leaves playback alone.
function PlaybackGapNotice({ codec, onDismiss }: { codec: CodecId; onDismiss: () => void }) {
	const { t } = useTranslation("preview")
	const { kind, label } = CODECS[codec]

	return (
		<div
			role="status"
			className={cn(
				"absolute inset-x-3 top-3 mx-auto flex w-fit max-w-full items-center gap-1 rounded-2xl py-1 pr-1 pl-3 text-sm",
				MEDIA_GLASS_SURFACE_CLASS
			)}
		>
			<p className="min-w-0">
				{kind === "audio" ? t("previewMediaNoSound", { codec: label }) : t("previewMediaNoPicture", { codec: label })}
			</p>
			<PreviewDownloadButton
				variant="ghost"
				size="sm"
			/>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label={t("previewMediaNoticeDismiss")}
				onClick={onDismiss}
			>
				<XIcon />
			</Button>
		</div>
	)
}
