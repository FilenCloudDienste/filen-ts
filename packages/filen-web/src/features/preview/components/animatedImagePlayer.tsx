import { use, useEffect, useEffectEvent, useState, useSyncExternalStore, type FocusEvent, type KeyboardEvent, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { PauseIcon, PlayIcon, SkipBackIcon, SkipForwardIcon } from "lucide-react"
import { cn } from "@filen/shared"
import { MediaScrubber } from "@/components/media/mediaScrubber"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { Kbd } from "@/lib/keymap/kbd"
import { MEDIA_GLASS_SURFACE_CLASS } from "@/components/ui/surface"
import type { DriveItem } from "@/features/drive/lib/item"
import { itemTypeExtension } from "@/features/drive/lib/preview.logic"
import { usePreviewCacheScope } from "@/features/preview/lib/accessMode"
import { getPreviewBytes } from "@/features/preview/lib/previewCache"
import { ANIMATABLE_EXTENSIONS, ANIMATION_KEY_ACTIONS, animationKeyCommand } from "@/features/preview/lib/animatedImage.logic"
import { imageDecoderAvailable, openAnimation, type AnimationSource } from "@/features/preview/lib/animatedImage"
import { AnimatedImagePlayback } from "@/features/preview/lib/animatedImagePlayback"
import { ZoomableCanvas } from "@/features/preview/components/zoomableImage"
import { PlaybackRateMenu } from "@/features/preview/components/playbackRateMenu"
import { SlideSignalsContext } from "@/features/preview/lib/slideSignals"
import { CONTROLS_IDLE_MS, controlsVisible, IdleTimer } from "@/lib/media/autoHide.logic"
import { mediaKeyAction, mediaKeyRepeats } from "@/lib/media/mediaKeys.logic"
import { playerKeyTarget } from "@/lib/media/playerKeys.logic"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { isRecordingCombo, useBindings } from "@/lib/keymap/registry"
import { log } from "@/lib/log"

const IS_MAC = isMacPlatform()

// An image that may animate (by its type), shown at `url` by `children` (the plain viewer). Where ImageDecoder plays
// it and its bytes say it animates, the player takes over once its first frame is decoded; until then, and for a
// still, `children` show it as before.
export function AnimatableImage({ item, url, alt, children }: { item: DriveItem; url: string; alt: string; children: ReactNode }) {
	if (!imageDecoderAvailable() || !ANIMATABLE_EXTENSIONS.has(itemTypeExtension(item))) {
		return children
	}

	return (
		<AnimationProbe
			item={item}
			url={url}
			alt={alt}
		>
			{children}
		</AnimationProbe>
	)
}

function AnimationProbe({ item, url, alt, children }: { item: DriveItem; url: string; alt: string; children: ReactNode }) {
	const cacheScope = usePreviewCacheScope()
	const uuid = item.data.uuid
	const size = Number(item.data.size)
	const key = `${uuid}\n${url}`
	const [opened, setOpened] = useState<{ key: string; source: AnimationSource } | null>(null)
	// Bytes already in memory are read at open, never keyed on: they land in the cache as a buffered load completes,
	// with the same url.
	const heldOf = useEffectEvent(() => getPreviewBytes(cacheScope, uuid))

	useEffect(() => {
		const controller = new AbortController()
		let source: AnimationSource | null = null

		openAnimation(heldOf(), url, size, controller.signal).then(
			result => {
				if (result === null) {
					return
				}

				if (controller.signal.aborted) {
					result.first.close()
					result.decoder.close()

					return
				}

				source = result
				setOpened({ key, source: result })
			},
			(error: unknown) => {
				if (!controller.signal.aborted) {
					log.warn("preview", "opening an animated image failed", error)
				}
			}
		)

		// Owns the decoder for as long as the player shows it.
		return () => {
			controller.abort()
			source?.first.close()
			source?.decoder.close()
		}
	}, [key, url, size])

	if (opened?.key !== key) {
		return children
	}

	return (
		<AnimatedImagePlayer
			key={key}
			source={opened.source}
			alt={alt}
		/>
	)
}

// The animation on a canvas inside the zoom, with the video preview's glass bar: play/pause, a frame either way, the
// frame scrubber and counter, and the speed. Plays on open and loops as the file says; the bar hides while it plays
// untouched. The clock stands still while the tab is hidden or the picture off screen. Under a slideshow it says it
// animates and reports the end of its first loop, looping on as the file says.
export function AnimatedImagePlayer({ source, alt }: { source: AnimationSource; alt: string }) {
	const { t } = useTranslation(["preview", "audio"])
	const [playback] = useState(() => new AnimatedImagePlayback(source.decoder, source.first, true))
	const signals = use(SlideSignalsContext)
	const snapshot = useSyncExternalStore(playback.subscribe, playback.getSnapshot)
	const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
	const [pointerActive, setPointerActive] = useState(false)
	const [keyboardFocus, setKeyboardFocus] = useState(false)
	const [menuOpen, setMenuOpen] = useState(false)
	const [scrubbing, setScrubbing] = useState(false)
	const [idleTimer] = useState(() => new IdleTimer(setPointerActive, CONTROLS_IDLE_MS))
	const combos = useBindings()
	const visible = controlsVisible({ paused: !snapshot.playing, waiting: false, pointerActive, keyboardFocus, menuOpen, scrubbing })
	const last = Math.max(0, snapshot.frameCount - 1)
	const counter = { frame: snapshot.index + 1, count: Math.max(snapshot.frameCount, snapshot.index + 1) }

	// Playback starting shows the controls for one idle period before they fade.
	useEffect(() => {
		playback.start()
		idleTimer.poke()

		return () => {
			playback.stop()
			idleTimer.stop()
		}
	}, [playback, idleTimer])

	useEffect(() => {
		if (signals === null) {
			return
		}

		signals.animating()

		const unsubscribe = playback.onLoopEnded(() => {
			unsubscribe()
			signals.mediaEnded()
		})

		return unsubscribe
	}, [playback, signals])

	useEffect(() => {
		function handleVisibility(): void {
			playback.setHold("hidden", document.visibilityState === "hidden")
		}

		handleVisibility()
		document.addEventListener("visibilitychange", handleVisibility)

		return () => {
			document.removeEventListener("visibilitychange", handleVisibility)
		}
	}, [playback])

	useEffect(() => {
		if (canvas === null || !("IntersectionObserver" in globalThis)) {
			return
		}

		const observer = new IntersectionObserver(entries => {
			const entry = entries.at(-1)

			if (entry !== undefined) {
				playback.setHold("offscreen", !entry.isIntersecting)
			}
		})

		observer.observe(canvas)

		return () => {
			observer.disconnect()
			playback.setHold("offscreen", false)
		}
	}, [playback, canvas])

	function seekTo(index: number): void {
		playback.seek(Math.max(0, Math.min(last, Math.round(index))))
	}

	function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
		if (event.defaultPrevented || isRecordingCombo()) {
			return
		}

		const action = mediaKeyAction(event, playerKeyTarget(event.target), ANIMATION_KEY_ACTIONS, combos, IS_MAC)
		const command = action === null ? null : animationKeyCommand(action, snapshot.rate)

		if (action === null || command === null) {
			return
		}

		// Past the player, the preview overlay would page on the same arrow.
		event.preventDefault()
		event.stopPropagation()
		idleTimer.poke()

		if (event.repeat && !mediaKeyRepeats(action)) {
			return
		}

		switch (command.type) {
			case "toggle":
				playback.toggle()
				break
			case "step":
				playback.step(command.direction)
				break
			case "seek":
				seekTo(command.to === "start" ? 0 : last)
				break
			case "rate":
				playback.setRate(command.rate)
				break
		}
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
		<div
			// Focusable, so a click on the picture hands the player the keyboard; it takes its own arrow keys, so the
			// preview overlay does not page on them.
			tabIndex={-1}
			data-preview-surface=""
			className={cn("relative size-full outline-none", !visible && "cursor-none")}
			onPointerMove={() => {
				idleTimer.poke()
			}}
			onPointerDown={() => {
				idleTimer.poke()
			}}
			onPointerLeave={event => {
				if (event.pointerType === "mouse") {
					idleTimer.idle()
				}
			}}
			onKeyDown={handleKeyDown}
			onFocus={handleFocus}
			onBlur={handleBlur}
		>
			<ZoomableCanvas
				width={playback.width}
				height={playback.height}
				alt={alt}
				canvasRef={element => {
					setCanvas(element)
					playback.attach(element?.getContext("2d") ?? null)
				}}
			/>
			<div
				role="group"
				aria-label={t("previewMediaControls")}
				className={cn(
					"@container absolute inset-x-3 bottom-3 mx-auto flex max-w-xl items-center gap-1 rounded-2xl px-2 py-1.5 transition-opacity duration-200 motion-reduce:transition-none",
					MEDIA_GLASS_SURFACE_CLASS,
					// Hidden, yet still in the tab order: a Tab onto a control brings the bar back.
					visible ? "opacity-100" : "pointer-events-none opacity-0"
				)}
			>
				<TooltipIconButton
					label={snapshot.playing ? t("audio:pause") : t("audio:play")}
					shortcut={<Kbd action="media.playPause" />}
					onClick={() => {
						playback.toggle()
					}}
				>
					{snapshot.playing ? <PauseIcon className="fill-current" /> : <PlayIcon className="fill-current" />}
				</TooltipIconButton>
				<TooltipIconButton
					label={t("previewAnimationPreviousFrame")}
					shortcut={<Kbd action="media.frameBack" />}
					disabled={snapshot.index <= 0}
					onClick={() => {
						playback.step(-1)
					}}
				>
					<SkipBackIcon />
				</TooltipIconButton>
				<TooltipIconButton
					label={t("previewAnimationNextFrame")}
					shortcut={<Kbd action="media.frameForward" />}
					disabled={snapshot.complete && snapshot.index >= last}
					onClick={() => {
						playback.step(1)
					}}
				>
					<SkipForwardIcon />
				</TooltipIconButton>
				<MediaScrubber
					value={snapshot.index}
					duration={last}
					label={t("previewAnimationFrameSlider")}
					step={1}
					tooltip={false}
					valueText={value => t("previewAnimationFrameOf", { frame: Math.round(value) + 1, count: counter.count })}
					onScrub={value => {
						setScrubbing(value !== null)
						playback.setHold("scrubbing", value !== null)

						if (value !== null) {
							seekTo(value)
						}
					}}
					onSeek={seekTo}
					onSeekBy={delta => {
						seekTo(snapshot.index + delta)
					}}
					className="mx-2 flex-1"
				/>
				<span className="min-w-12 shrink-0 text-xs text-muted-foreground tabular-nums">
					{t("previewAnimationFrameCounter", counter)}
				</span>
				<PlaybackRateMenu
					rate={snapshot.rate}
					onRate={rate => {
						playback.setRate(rate)
					}}
					container={null}
					onOpenChange={setMenuOpen}
				/>
			</div>
		</div>
	)
}

// The video preview's speed menu over the animation's clock rather than a media element.
