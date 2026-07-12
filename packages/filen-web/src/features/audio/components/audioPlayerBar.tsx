import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Play, Pause, SkipForward, SkipBack, Shuffle, Repeat, Repeat1, Volume2, VolumeX, ListMusic, Music } from "lucide-react"
import { audioEngine } from "@/features/audio/lib/audioEngine"
import { useAudioNowPlaying, useAudioQueueControls, useAudioOutput, useAudioError } from "@/features/audio/store/useAudioStore"
import { NowPlayingPanel } from "@/features/audio/components/nowPlayingPanel"
import { nextLoopMode } from "@/features/audio/components/audioTransport.logic"
import { formatTime } from "@/features/audio/lib/format"
import { registerAudioActions } from "@/features/audio/lib/keymap"
import { useAction } from "@/lib/keymap/useAction"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

// Transport keyboard shortcuts (mod+shift chords — see AUDIO_ACTIONS for the non-collision rationale).
// Registered once at module load; the idempotent guard inside makes a re-import harmless.
registerAudioActions()

// The persistent audio player, docked at the bottom of the authed shell (rendered once by AppShell,
// which never mounts on public-link routes — so this surface is inherently authed-only). It renders
// nothing until a queue exists; the drive audio-handoff (or a playlist play) fills the queue and the bar
// appears. Desktop bottom-bar idiom: track identity on the left, transport + scrubber in the center,
// output + queue controls on the right; it collapses to essentials on narrow widths. The engine
// singleton owns playback — every control here is a thin imperative call into it, and all displayed
// state is read reactively from the store the engine drives.
export function AudioPlayerBar() {
	const { t } = useTranslation("audio")
	const { status, positionMs, durationMs, track } = useAudioNowPlaying()
	const { shuffleEnabled, loopMode, hasQueue } = useAudioQueueControls()
	const { volume, muted } = useAudioOutput()
	const lastError = useAudioError()
	const [queueOpen, setQueueOpen] = useState(false)

	// Transport keyboard shortcuts — bound whenever the bar is mounted (i.e. whenever a queue exists).
	// Fired against the engine directly; a no-op when there is nothing to do.
	useAction("audio.playPause", () => {
		audioEngine.toggle()
	})
	useAction("audio.next", () => {
		void audioEngine.skipNext()
	})
	useAction("audio.previous", () => {
		void audioEngine.skipPrevious()
	})

	// No queue → no bar. Placed AFTER the hooks so hook order stays stable across renders (the shell
	// mounts this component unconditionally).
	if (!hasQueue) {
		return null
	}

	const isPlaying = status === "playing"
	const isLoading = status === "loading"
	const LoopIcon = loopMode === "one" ? Repeat1 : Repeat
	const seekMax = durationMs > 0 ? durationMs : 0

	return (
		<section
			aria-label={t("playerLabel")}
			className="flex flex-col gap-1 border-t border-border bg-card px-3 py-2 text-foreground"
		>
			{lastError !== null ? (
				<p
					role="alert"
					className="truncate px-1 text-xs text-destructive"
				>
					{errorLabel(lastError)}
				</p>
			) : null}
			<div className="flex items-center gap-3">
				{/* Left: cover-art slot (placeholder until the metadata step) + track identity. */}
				<div className="flex min-w-0 flex-[1_1_0] items-center gap-3">
					<div className="flex size-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-muted-foreground">
						<Music className="size-5" />
					</div>
					<div className="min-w-0">
						<p
							title={track?.name ?? t("nothingPlaying")}
							className="truncate text-sm font-medium"
						>
							{track?.name ?? t("nothingPlaying")}
						</p>
						<p className="truncate text-xs text-muted-foreground">{t("unknownArtist")}</p>
					</div>
				</div>

				{/* Center: transport + scrubber. */}
				<div className="flex flex-[2_1_0] flex-col items-center gap-1">
					<div className="flex items-center gap-1">
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={t("shuffle")}
							aria-pressed={shuffleEnabled}
							className={cn("hidden sm:inline-flex", shuffleEnabled && "text-primary")}
							onClick={() => {
								audioEngine.setShuffleEnabled(!shuffleEnabled)
							}}
						>
							<Shuffle />
						</Button>
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
							aria-label={isPlaying ? t("pause") : t("play")}
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
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={loopMode === "off" ? t("loopOff") : loopMode === "all" ? t("loopAll") : t("loopOne")}
							aria-pressed={loopMode !== "off"}
							className={cn("hidden sm:inline-flex", loopMode !== "off" && "text-primary")}
							onClick={() => {
								audioEngine.setLoopMode(nextLoopMode(loopMode))
							}}
						>
							<LoopIcon />
						</Button>
					</div>
					<div className="flex w-full items-center gap-2">
						<span className="w-9 shrink-0 text-right text-[0.7rem] text-muted-foreground tabular-nums">
							{formatTime(positionMs)}
						</span>
						<input
							type="range"
							min={0}
							max={seekMax}
							step={1000}
							value={Math.min(positionMs, seekMax)}
							aria-label={t("seek")}
							disabled={seekMax === 0}
							className="h-1 min-w-0 flex-1 cursor-pointer accent-primary"
							onChange={event => {
								audioEngine.seek(Number(event.target.value) / 1000)
							}}
						/>
						<span className="w-9 shrink-0 text-[0.7rem] text-muted-foreground tabular-nums">{formatTime(durationMs)}</span>
					</div>
				</div>

				{/* Right: output + queue. */}
				<div className="flex flex-[1_1_0] items-center justify-end gap-1">
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={muted ? t("unmute") : t("mute")}
						aria-pressed={muted}
						onClick={() => {
							audioEngine.toggleMuted()
						}}
					>
						{muted ? <VolumeX /> : <Volume2 />}
					</Button>
					<input
						type="range"
						min={0}
						max={1}
						step={0.01}
						value={muted ? 0 : volume}
						aria-label={t("volume")}
						className="hidden h-1 w-24 cursor-pointer accent-primary lg:inline-block"
						onChange={event => {
							audioEngine.setVolume(Number(event.target.value))
						}}
					/>
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
									className={cn(queueOpen && "text-primary")}
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
