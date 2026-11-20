import { useTranslation } from "react-i18next"
import type { ProbeAudio, VideoProbe } from "@filen/shared/videos"
import { SUBTITLE_ENCODINGS } from "@filen/shared/textEncoding"
import { Button } from "@/components/ui/button"
import { TracksPopover, type TrackOption } from "@/components/media/video/tracksPopover"
import { useTranscodedTracks } from "@/lib/media/playback/useTranscodedTracks"
import type { PlayerSubtitleTrack, SubtitleChoice } from "@/features/videos/lib/player/subtitles.logic"
import { encodingOptionLabel } from "@/features/preview/lib/textFile"
import { audioTrackDetail, audioTrackName, subtitleTrackName } from "@/features/videos/lib/player/trackLabels.logic"
import type { VideoFileRef } from "@/workers/videoIndex/view.logic"

// The Videos player's audio and subtitle choices in the tracks popover: labels from the probe and the sidecar
// names, Smart showing what it picked, a marker on audio this browser plays only converted.

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
	const { t: tPreview } = useTranslation("preview")
	const transcoded = useTranscodedTracks(probe, file?.size ?? 0, open)

	function subtitleName(track: PlayerSubtitleTrack): string {
		return subtitleTrackName(track, t)
	}

	function audioOption(track: ProbeAudio, index: number): TrackOption {
		const name = audioTrackName(track, index, t)
		const detail = audioTrackDetail(track, t)
		const converted = transcoded.has(index) || (index === audioIndex && decisionAudioMode === "transcode")

		return {
			id: String(index),
			label: name,
			detail: detail ?? undefined,
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
					? t("subtitleFormatUnsupported")
					: track.unavailable === "playback"
						? t("subtitleEmbeddedUnplayable")
						: track.unavailable === "image"
							? t("subtitleImageUnavailable")
							: [track.title, track.format?.toUpperCase()]
									.filter(part => part !== undefined && part.length > 0)
									.join(" · ") || undefined,
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
										{encodingOptionLabel(entry, tPreview)}
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
