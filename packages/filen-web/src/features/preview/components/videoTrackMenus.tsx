import { useState } from "react"
import { useTranslation } from "react-i18next"
import { CaptionsIcon, ListIcon } from "lucide-react"
import { cn, formatSecondsToMediaClock } from "@filen/shared"
import { languageName, type LadderDecision, type VideoProbe } from "@filen/shared/videos"
import { Button } from "@/components/ui/button"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { MEDIA_GLASS_TONE_CLASS } from "@/components/ui/surface"
import { chapterAt, type StageChapter } from "@/components/media/video/stage.logic"
import { useTranscodedTracks } from "@/lib/media/playback/useTranscodedTracks"
import { seekMedia, useMediaCurrentTime } from "@/lib/media/useMediaState"
import { audioTrackDetail, audioTrackName } from "@/features/videos/lib/player/trackLabels.logic"
import type { NativeAudioTrack } from "@/features/preview/lib/previewVideo"
import type { PreviewSubtitleOption, PreviewSubtitles } from "@/features/preview/hooks/usePreviewSubtitles"

// The preview player's track menus over the picture: audio and subtitles in one, chapters in another. Both are built
// from what the controller already holds; only the audio section's "converted" note asks anything, and only while
// the menu is open.

type SubtitleLabelKey =
	"previewMediaSubtitleUnknownLanguage" | "previewMediaSubtitleForced" | "previewMediaSubtitleSdh" | "previewMediaSubtitleEmbedded"

// "English · Forced · Embedded": the language, the track's own title, then its flags.
function subtitleLabel(option: PreviewSubtitleOption, t: (key: SubtitleLabelKey) => string): string {
	const parts = [languageName(option.lang) ?? t("previewMediaSubtitleUnknownLanguage")]

	if (option.title.length > 0) {
		parts.push(option.title)
	}

	if (option.forced) {
		parts.push(t("previewMediaSubtitleForced"))
	}

	if (option.sdh) {
		parts.push(t("previewMediaSubtitleSdh"))
	}

	if (option.embedded) {
		parts.push(t("previewMediaSubtitleEmbedded"))
	}

	return parts.join(" · ")
}

interface AudioOption {
	label: string
	detail: string | null
	converted: boolean
}

// The audio tracks to choose between: the probe's, named as the Videos player names them, else the element's own
// (WebKit, before any probe). None where there is only one.
function useAudioOptions(params: {
	probe: VideoProbe | null
	nativeAudio: readonly NativeAudioTrack[] | null
	decision: LadderDecision | null
	audioIndex: number
	size: number
	open: boolean
}): AudioOption[] {
	const { t } = useTranslation("videos")
	const transcoded = useTranscodedTracks(params.probe, params.size, params.open)
	const { probe, nativeAudio } = params

	if (probe !== null && probe.audio.length >= 2) {
		return probe.audio.map((track, index) => ({
			label: audioTrackName(track, index, t),
			detail: audioTrackDetail(track, t),
			converted: transcoded.has(index) || (index === params.audioIndex && params.decision?.audio.mode === "transcode")
		}))
	}

	if (nativeAudio !== null && nativeAudio.length >= 2) {
		return nativeAudio.map((track, index) => ({
			label: languageName(track.language) ?? (track.label.length > 0 ? track.label : t("playerTrackNumber", { number: index + 1 })),
			detail: track.label.length > 0 && languageName(track.language) !== null ? track.label : null,
			converted: false
		}))
	}

	return []
}

export function TracksMenu({
	subtitles,
	probe,
	nativeAudio,
	decision,
	audioIndex,
	onAudio,
	size,
	container,
	onOpenChange
}: {
	subtitles: PreviewSubtitles
	probe: VideoProbe | null
	nativeAudio: readonly NativeAudioTrack[] | null
	decision: LadderDecision | null
	audioIndex: number
	onAudio: (index: number) => void
	// The file's bytes, for the "converted" note's decoder questions.
	size: number
	container: HTMLElement | null
	onOpenChange: (open: boolean) => void
}) {
	const { t } = useTranslation(["preview", "videos"])
	const [open, setOpen] = useState(false)
	const audio = useAudioOptions({ probe, nativeAudio, decision, audioIndex, size, open })
	const hasSubtitles = subtitles.options.length > 0

	if (audio.length === 0 && !hasSubtitles) {
		return null
	}

	const label = audio.length > 0 ? t("videos:playerTracks") : t("previewMediaSubtitles")

	return (
		<DropdownMenu
			onOpenChange={next => {
				setOpen(next)
				onOpenChange(next)
			}}
		>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={label}
					>
						<CaptionsIcon />
					</Button>
				}
			/>
			<DropdownMenuContent
				side="top"
				align="end"
				container={container ?? undefined}
				// The menu opens over the picture, so it wears the controls' dark tone rather than the app's glass.
				className={cn(
					MEDIA_GLASS_TONE_CLASS,
					"max-h-[min(28rem,var(--available-height))] w-auto max-w-80 min-w-44 before:backdrop-saturate-100"
				)}
			>
				{audio.length > 0 ? (
					<DropdownMenuRadioGroup
						value={String(audioIndex)}
						onValueChange={(next: string) => {
							onAudio(Number(next))
						}}
					>
						<DropdownMenuLabel>{t("videos:playerAudio")}</DropdownMenuLabel>
						{audio.map((option, index) => (
							<DropdownMenuRadioItem
								key={index}
								value={String(index)}
							>
								<span className="flex min-w-0 flex-col">
									<span className="truncate">{option.label}</span>
									{option.detail === null && !option.converted ? null : (
										<span className="truncate text-xs text-muted-foreground">
											{[option.detail, option.converted ? t("videos:playerAudioTranscoded") : null]
												.filter(part => part !== null)
												.join(" · ")}
										</span>
									)}
								</span>
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				) : null}
				{audio.length > 0 && hasSubtitles ? <DropdownMenuSeparator /> : null}
				{hasSubtitles ? (
					<DropdownMenuRadioGroup
						value={subtitles.selected}
						onValueChange={(next: string) => {
							subtitles.select(next)
						}}
					>
						<DropdownMenuLabel>{t("previewMediaSubtitles")}</DropdownMenuLabel>
						<DropdownMenuRadioItem value="off">{t("previewMediaSubtitlesOff")}</DropdownMenuRadioItem>
						{subtitles.options.map(option => (
							<DropdownMenuRadioItem
								key={option.id}
								value={option.id}
							>
								<span className="truncate">
									{subtitles.failed && option.id === subtitles.selected
										? t("previewMediaSubtitleUnreadable", { name: subtitleLabel(option, key => t(key)) })
										: subtitleLabel(option, key => t(key))}
								</span>
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// The chapters, with the one playing marked; picking one seeks to its start. Shown from two chapters on.
export function ChaptersMenu({
	chapters,
	media,
	container,
	onOpenChange
}: {
	chapters: readonly StageChapter[]
	media: HTMLMediaElement | null
	container: HTMLElement | null
	onOpenChange: (open: boolean) => void
}) {
	const { t } = useTranslation("preview")

	return (
		<DropdownMenu onOpenChange={onOpenChange}>
			<DropdownMenuTrigger
				render={
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={t("previewMediaChapters")}
					>
						<ListIcon />
					</Button>
				}
			/>
			<DropdownMenuContent
				side="top"
				align="end"
				container={container ?? undefined}
				className={cn(
					MEDIA_GLASS_TONE_CLASS,
					"max-h-[min(28rem,var(--available-height))] w-auto max-w-80 min-w-44 before:backdrop-saturate-100"
				)}
			>
				<DropdownMenuGroup>
					<DropdownMenuLabel>{t("previewMediaChapters")}</DropdownMenuLabel>
					<ChapterItems
						chapters={chapters}
						media={media}
					/>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// Mounted only while the menu is open, so the playhead re-renders nothing otherwise.
function ChapterItems({ chapters, media }: { chapters: readonly StageChapter[]; media: HTMLMediaElement | null }) {
	const { t } = useTranslation("preview")
	const current = chapterAt(chapters, useMediaCurrentTime(media))

	return chapters.map((chapter, index) => (
		<DropdownMenuItem
			key={chapter.start}
			aria-current={chapter === current ? "true" : undefined}
			className={cn("gap-3", chapter === current && "font-medium")}
			onClick={() => {
				if (media !== null) {
					seekMedia(media, chapter.start)
				}
			}}
		>
			<span className="min-w-0 flex-1 truncate">
				{chapter.title !== null && chapter.title.length > 0 ? chapter.title : t("previewMediaChapterNumber", { number: index + 1 })}
			</span>
			<span className="text-xs text-muted-foreground tabular-nums">{formatSecondsToMediaClock(chapter.start)}</span>
		</DropdownMenuItem>
	))
}
