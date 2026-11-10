import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { SUBTITLE_ENCODINGS, decidePlayback, type ProbeAudio, type VideoProbe } from "@filen/shared/videos"
import { Button } from "@/components/ui/button"
import { TracksPopover, type TrackOption } from "@/components/media/video/tracksPopover"
import { playbackCapabilities } from "@/lib/media/playback/capabilities"
import { streamFacts, toLadderProbe } from "@/lib/media/playback/capabilities.logic"
import type { PlayerSubtitleTrack, SubtitleChoice } from "@/features/videos/lib/player/subtitles.logic"
import { audioTrackName, subtitleTrackName } from "@/features/videos/lib/player/trackLabels.logic"
import type { VideoFileRef } from "@/workers/videoIndex/view.logic"

// The Videos player's audio and subtitle choices in the tracks popover: labels from the probe and the sidecar
// names, Smart showing what it picked, a marker on audio this browser plays only converted.

const CODEC_NAMES: Readonly<Record<string, string>> = {
	aac: "AAC",
	mp3: "MP3",
	ac3: "Dolby Digital",
	eac3: "Dolby Digital Plus",
	dts: "DTS",
	truehd: "TrueHD",
	opus: "Opus",
	vorbis: "Vorbis",
	flac: "FLAC",
	alac: "ALAC"
}

// Which audio tracks this browser plays only re-encoded, asked when the menu opens (decoder answers are kept
// per session, so it costs nothing after the first time).
function useTranscodedTracks(probe: VideoProbe | null, size: number, open: boolean): ReadonlySet<number> {
	const [transcoded, setTranscoded] = useState<ReadonlySet<number>>(new Set())

	useEffect(() => {
		if (!open || probe === null || probe.audio.length === 0) {
			return
		}

		let live = true
		const ladderProbe = toLadderProbe(probe)

		void Promise.all(
			probe.audio.map(async (_, index) => {
				const selection = { audioIndex: index, subtitle: "none" as const }
				const caps = await playbackCapabilities.capabilities(ladderProbe, selection, streamFacts({ probe, selection, size }))

				return decidePlayback(ladderProbe, selection, caps).audio.mode === "transcode" ? index : -1
			})
		).then(
			results => {
				if (live) {
					setTranscoded(new Set(results.filter(index => index >= 0)))
				}
			},
			() => undefined
		)

		return () => {
			live = false
		}
	}, [probe, size, open])

	return transcoded
}

export function PlayerTracks({
	probe,
	file,
	audioIndex,
	decisionAudioMode,
	onAudio,
	tracks,
	choice,
	resolved,
	onSubtitle,
	encoding,
	detectedEncoding,
	onEncoding,
	onStyle,
	onDelay,
	open,
	onOpenChange
}: {
	probe: VideoProbe | null
	file: VideoFileRef | null
	audioIndex: number
	decisionAudioMode: string | null
	onAudio: (index: number) => void
	tracks: readonly PlayerSubtitleTrack[]
	choice: SubtitleChoice
	resolved: PlayerSubtitleTrack | null
	onSubtitle: (choice: SubtitleChoice) => void
	// The encoding chosen for the shown sidecar, null for automatic.
	encoding: string | null
	detectedEncoding: string | null
	onEncoding: (encoding: string | null) => void
	onStyle: () => void
	onDelay: () => void
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const { t } = useTranslation("videos")
	const transcoded = useTranscodedTracks(probe, file?.size ?? 0, open)

	function subtitleName(track: PlayerSubtitleTrack): string {
		return subtitleTrackName(track, t)
	}

	function audioOption(track: ProbeAudio, index: number): TrackOption {
		const name = audioTrackName(track, index, t)
		const details = [
			track.commentary ? t("playerAudioCommentary") : null,
			track.name,
			track.codec === null ? null : (CODEC_NAMES[track.codec] ?? null)
		].filter((part): part is string => part !== null && part.length > 0)
		const converted = transcoded.has(index) || (index === audioIndex && decisionAudioMode === "transcode")

		return {
			id: String(index),
			label: name,
			detail: details.length === 0 ? undefined : [...new Set(details)].join(" · "),
			note: converted ? t("playerAudioTranscoded") : undefined
		}
	}

	const audio: TrackOption[] =
		probe === null || probe.audio.length === 0
			? [{ id: "-1", label: t("playerAudioNone"), disabled: true }]
			: probe.audio.map(audioOption)
	const subtitleOptions: TrackOption[] = [
		{
			id: "auto",
			label: t("subtitleAuto"),
			detail:
				choice.kind === "auto"
					? resolved === null
						? t("subtitleAutoNone")
						: t("subtitleAutoShowing", { track: subtitleName(resolved) })
					: undefined
		},
		{ id: "off", label: t("subtitleOff") },
		...tracks.map(track => ({
			id: track.id,
			label: subtitleName(track),
			detail:
				track.unavailable === "embedded"
					? t("subtitleEmbeddedUnavailable")
					: track.unavailable === "image"
						? t("subtitleImageUnavailable")
						: [track.title, track.format?.toUpperCase()].filter(part => part !== undefined && part.length > 0).join(" · ") ||
							undefined,
			disabled: track.unavailable !== null
		}))
	]
	const subtitleValue = choice.kind === "track" ? choice.id : choice.kind

	return (
		<TracksPopover
			label={t("playerTracks")}
			audio={audio}
			audioValue={String(audioIndex)}
			onAudio={id => {
				onAudio(Number(id))
			}}
			subtitles={subtitleOptions}
			subtitleValue={subtitleValue}
			onSubtitle={id => {
				onSubtitle(id === "auto" ? { kind: "auto" } : id === "off" ? { kind: "off" } : { kind: "track", id })
			}}
			open={open}
			onOpenChange={onOpenChange}
			footer={
				<>
					{resolved?.file === null || resolved === null ? null : (
						<label className="mr-auto flex items-center gap-2 px-2 text-xs text-muted-foreground">
							{t("subtitleEncoding")}
							<select
								value={encoding ?? ""}
								className="h-7 max-w-44 rounded-lg bg-white/10 px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-white/40"
								onChange={event => {
									onEncoding(event.target.value === "" ? null : event.target.value)
								}}
							>
								<option value="">{t("subtitleEncodingAuto", { encoding: detectedEncoding ?? "…" })}</option>
								{SUBTITLE_ENCODINGS.map(entry => (
									<option
										key={entry.label}
										value={entry.label}
									>
										{entry.name}
									</option>
								))}
							</select>
						</label>
					)}
					<Button
						variant="ghost"
						size="sm"
						onClick={onStyle}
					>
						{t("subtitleStyleOpen")}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						onClick={onDelay}
					>
						{t("subtitleDelayOpen")}
					</Button>
				</>
			}
		/>
	)
}
