import { useState, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { Play, Pause, SkipForward, SkipBack, ListMusic, Music } from "lucide-react"
import { useShallow } from "zustand/shallow"
import { audioEngine, audioMediaSession } from "@/features/audio/lib/audioEngine"
import { transportKeyIgnored } from "@/features/audio/lib/transportKeys"
import { AUDIO_BAR_MEDIA_ACTIONS, audioSeekTarget, runAudioMediaAction } from "@/features/audio/lib/barKeys"
import { nextLoopMode } from "@/features/audio/components/audioTransport.logic"
import { useAudioStore, useAudioNowPlaying, useAudioError } from "@/features/audio/store/useAudioStore"
import { playbackErrorLabel } from "@/features/audio/lib/formatFailureNotice"
import { MEDIA_FORMAT_UNSUPPORTED } from "@/lib/media/mediaFailure"
import { NowPlayingPanel } from "@/features/audio/components/nowPlayingPanel"
import { ShuffleToggleButton, LoopToggleButton, TOGGLE_ON_CLASS } from "@/features/audio/components/queueToggles"
import { SmoothTransitionsToggleButton } from "@/features/audio/components/smoothTransitionsToggle"
import { toggleSmoothTransitionsByUser } from "@/features/audio/lib/smoothTransitionsUi"
import { useAction } from "@/lib/keymap/useAction"
import { isRecordingCombo, useBindings } from "@/lib/keymap/registry"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { MEDIA_SEEK_STEP_SECONDS, MEDIA_VOLUME_STEP, mediaKeyAction, mediaKeyRepeats } from "@/lib/media/mediaKeys.logic"
import { playerKeyTarget } from "@/lib/media/playerKeys.logic"
import { stepMediaVolume, toggleMediaMuted } from "@/lib/media/mediaVolume"
import type { Options } from "react-hotkeys-hook"
import { Button } from "@/components/ui/button"
import { MediaScrubber } from "@/components/media/mediaScrubber"
import { VolumeControl } from "@/components/media/volumeControl"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { toastObstructionRef } from "@/lib/toastClearance"
import { formatSecondsToMediaClock } from "@filen/shared"
import { SplitTitle } from "@/features/preview/components/splitTitle"

const IS_MAC = isMacPlatform()

// With no queue there is nothing to play, seek or turn up: the keys stay the page's.
const TRANSPORT_KEYS: Options = {
	ignoreEventWhen: event => transportKeyIgnored(event, audioMediaSession) || useAudioStore.getState().queue.length === 0
}

// The playhead and the track's length, in seconds, read when a key fires.
function audioPosition(): { position: number; duration: number } {
	const { positionMs, durationMs } = useAudioStore.getState()

	return { position: positionMs / 1000, duration: durationMs / 1000 }
}

function seekAudioBy(seconds: number): void {
	const { position, duration } = audioPosition()

	audioEngine.seek(audioSeekTarget(position + seconds, duration))
}

// The persistent audio player, docked at the bottom of the authed shell (rendered once by AppShell,
// which never mounts on public-link routes — so this surface is inherently authed-only). It renders
// nothing until a queue exists; the drive audio-handoff (or a playlist play) fills the queue and the bar
// appears. Desktop bottom-bar idiom: track identity on the left, transport + scrubber in the center,
// output + queue controls on the right; it collapses to essentials on narrow widths. The engine
// singleton owns playback — every control here is a thin imperative call into it, and all displayed
// state is read reactively from the store the engine drives.
export function AudioPlayerBar() {
	const { t } = useTranslation(["audio", "common"])
	const { status, track, title, artist, coverUrl } = useAudioNowPlaying()
	const hasQueue = useAudioStore(state => state.queue.length > 0)
	const lastError = useAudioError()
	const lastErrorTrack = useAudioStore(state => state.lastErrorTrack)
	const [queueOpen, setQueueOpen] = useState(false)
	const combos = useBindings()

	// Transport keyboard shortcuts — bound whenever the bar is mounted (the shell mounts it always), and standing down
	// while there is no queue. Fired against the engine directly.
	useAction(
		"audio.playPause",
		() => {
			audioEngine.toggle()
		},
		TRANSPORT_KEYS
	)
	useAction(
		"audio.next",
		() => {
			void audioEngine.skipNext()
		},
		TRANSPORT_KEYS
	)
	useAction(
		"audio.previous",
		() => {
			void audioEngine.skipPrevious()
		},
		TRANSPORT_KEYS
	)
	useAction(
		"audio.seekBack",
		() => {
			seekAudioBy(-MEDIA_SEEK_STEP_SECONDS)
		},
		TRANSPORT_KEYS
	)
	useAction(
		"audio.seekForward",
		() => {
			seekAudioBy(MEDIA_SEEK_STEP_SECONDS)
		},
		TRANSPORT_KEYS
	)
	useAction(
		"audio.volumeUp",
		() => {
			stepMediaVolume(MEDIA_VOLUME_STEP)
		},
		TRANSPORT_KEYS
	)
	useAction(
		"audio.volumeDown",
		() => {
			stepMediaVolume(-MEDIA_VOLUME_STEP)
		},
		TRANSPORT_KEYS
	)
	useAction("audio.mute", toggleMediaMuted, TRANSPORT_KEYS)
	useAction(
		"audio.shuffle",
		() => {
			audioEngine.setShuffleEnabled(!useAudioStore.getState().shuffleEnabled)
		},
		TRANSPORT_KEYS
	)
	useAction(
		"audio.loop",
		() => {
			audioEngine.setLoopMode(nextLoopMode(useAudioStore.getState().loopMode))
		},
		TRANSPORT_KEYS
	)
	useAction("audio.smoothTransitions", toggleSmoothTransitionsByUser, TRANSPORT_KEYS)
	useAction(
		"audio.toggleQueue",
		() => {
			setQueueOpen(open => !open)
		},
		TRANSPORT_KEYS
	)

	// The players' media keys, while focus is in the bar (its buttons; its sliders keep their arrows). A key pressed in
	// the queue popover, which React bubbles here from its portal, stays the popover's.
	function handleKeyDown(event: KeyboardEvent<HTMLElement>): void {
		if (
			event.defaultPrevented ||
			isRecordingCombo() ||
			!(event.target instanceof Node) ||
			!event.currentTarget.contains(event.target)
		) {
			return
		}

		const action = mediaKeyAction(event, playerKeyTarget(event.target), AUDIO_BAR_MEDIA_ACTIONS, combos, IS_MAC)

		if (action === null) {
			return
		}

		event.preventDefault()
		event.stopPropagation()

		if (!event.repeat || mediaKeyRepeats(action)) {
			runAudioMediaAction(action, audioEngine, audioPosition())
		}
	}

	// No queue → no bar. Placed AFTER the hooks so hook order stays stable across renders (the shell
	// mounts this component unconditionally).
	if (!hasQueue) {
		return null
	}

	const isPlaying = status === "playing"
	const isLoading = status === "loading"

	return (
		<section
			ref={toastObstructionRef}
			aria-label={t("playerLabel")}
			className="flex flex-col gap-1 border-t border-shell-border bg-card px-3 py-2 text-foreground"
			onKeyDown={handleKeyDown}
		>
			{lastError !== null ? (
				<div
					role="alert"
					className="flex items-center gap-2 px-1"
				>
					<p className="min-w-0 flex-1 truncate text-xs text-destructive">
						{playbackErrorLabel(lastError, lastErrorTrack, track)}
					</p>
					{/* No retry plays a format the browser cannot decode. */}
					{lastError.kind !== MEDIA_FORMAT_UNSUPPORTED ? (
						<Button
							variant="ghost"
							size="sm"
							className="h-6 shrink-0 px-2 text-xs"
							onClick={() => {
								void audioEngine.playCurrent()
							}}
						>
							{t("common:tryAgain")}
						</Button>
					) : null}
				</div>
			) : null}
			<div className="flex items-center gap-3">
				{/* Left: cover art (once tags resolve) + track identity. */}
				<div className="flex min-w-0 flex-[1_1_0] items-center gap-3">
					<div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
						{coverUrl ? (
							<img
								src={coverUrl}
								alt=""
								className="size-full object-cover"
							/>
						) : (
							<Music className="size-5" />
						)}
					</div>
					<div className="min-w-0">
						{track ? <TrackTitle title={title} /> : <p className="truncate text-sm font-medium">{t("nothingPlaying")}</p>}
						<p className="truncate text-xs text-muted-foreground">{artist ?? t("unknownArtist")}</p>
					</div>
				</div>

				{/* Center: transport + scrubber. */}
				<div className="flex flex-[2_1_0] flex-col items-center gap-1">
					<div className="flex items-center gap-1">
						<ShuffleToggleButton className="hidden sm:inline-flex" />
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={t("previous")}
							onClick={() => {
								void audioEngine.skipPrevious()
							}}
						>
							<SkipBack />
						</Button>
						<Button
							variant="default"
							size="icon"
							aria-label={isPlaying || isLoading ? t("pause") : t("play")}
							onClick={() => {
								audioEngine.toggle()
							}}
						>
							{isLoading ? <Spinner className="size-4" /> : isPlaying ? <Pause /> : <Play />}
						</Button>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={t("next")}
							onClick={() => {
								void audioEngine.skipNext()
							}}
						>
							<SkipForward />
						</Button>
						<LoopToggleButton className="hidden sm:inline-flex" />
						<SmoothTransitionsToggleButton className="hidden sm:inline-flex" />
					</div>
					<PlayerBarTimeline />
				</div>

				{/* Right: output + queue. */}
				<div className="flex flex-[1_1_0] items-center justify-end gap-1">
					<VolumeControl sliderClassName="hidden lg:flex w-24" />
					<Popover
						open={queueOpen}
						onOpenChange={setQueueOpen}
					>
						<PopoverTrigger
							render={
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={t("showQueue")}
									aria-pressed={queueOpen}
									className={TOGGLE_ON_CLASS}
								>
									<ListMusic />
								</Button>
							}
						/>
						<PopoverContent
							align="end"
							side="top"
							className="w-80"
						>
							<NowPlayingPanel />
						</PopoverContent>
					</Popover>
				</div>
			</div>
		</section>
	)
}

// The playhead readouts and scrubber, apart from the bar so a position write re-renders only them. The
// elapsed readout follows a drag, so no tip has to pop up over the transport above the rail.
function PlayerBarTimeline() {
	const { t } = useTranslation("audio")
	const { positionMs, durationMs } = useAudioStore(
		useShallow(state => ({
			positionMs: state.positionMs,
			durationMs: state.durationMs
		}))
	)
	const [dragSeconds, setDragSeconds] = useState<number | null>(null)

	return (
		<div className="flex w-full items-center gap-2">
			<span className="w-9 shrink-0 text-right text-[0.7rem] text-muted-foreground tabular-nums">
				{formatSecondsToMediaClock(dragSeconds ?? positionMs / 1000)}
			</span>
			<MediaScrubber
				value={positionMs / 1000}
				duration={durationMs / 1000}
				label={t("seek")}
				tooltip={false}
				onScrub={setDragSeconds}
				className="flex-1"
				onSeek={seconds => {
					audioEngine.seek(seconds)
				}}
			/>
			<span className="w-9 shrink-0 text-[0.7rem] text-muted-foreground tabular-nums">
				{formatSecondsToMediaClock(durationMs / 1000)}
			</span>
		</div>
	)
}

// The title's head truncates to the width there is while its tail (the extension of an untagged file)
// stays in view: one ellipsis, in the middle, as the preview overlay's header does it.
function TrackTitle({ title }: { title: string }) {
	return (
		<span
			title={title}
			className="flex min-w-0 text-sm font-medium"
		>
			<SplitTitle
				text={title}
				tailLength={10}
			/>
		</span>
	)
}
