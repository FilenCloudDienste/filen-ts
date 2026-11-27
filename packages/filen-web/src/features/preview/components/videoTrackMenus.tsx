import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { CaptionsIcon, ListIcon } from "lucide-react"
import { cn, formatSecondsToMediaClock } from "@filen/shared"
import { languageName, type LadderDecision, type VideoProbe } from "@filen/shared/videos"
import { Button } from "@/components/ui/button"
import { MediaTooltip } from "@/components/media/video/stageButton"
import {
	DropdownMenu,
	DropdownMenuContent,
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
import { audioTrackDetail, audioTrackName, trackLanguageName } from "@/features/videos/lib/player/trackLabels.logic"
import type { NativeAudioTrack } from "@/features/preview/lib/previewVideo"
import { menuListsProbeAudio } from "@/features/preview/lib/audioTrackMenu.logic"
import type { PreviewSubtitleOption, PreviewSubtitles } from "@/features/preview/hooks/usePreviewSubtitles"

// The preview player's track menus over the picture: audio and subtitles in one, chapters in another. Both are built
// from what the controller already holds; only the audio section's "converted" note asks anything, and only while
// the menu is open.

type SubtitleLabelKey =
	"previewMediaSubtitleUnknownLanguage" | "previewMediaSubtitleForced" | "previewMediaSubtitleSdh" | "previewMediaSubtitleEmbedded"

// "English · Forced · Embedded": the language, the track's own title, then its flags.
function subtitleLabel(option: PreviewSubtitleOption, uiLanguage: string, t: (key: SubtitleLabelKey) => string): string {
	const parts = [trackLanguageName(option.lang, uiLanguage) ?? t("previewMediaSubtitleUnknownLanguage")]

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
	const { t, i18n } = useTranslation("videos")
	const transcoded = useTranscodedTracks(params.probe, params.size, params.open)
	const { probe, nativeAudio } = params

	if (menuListsProbeAudio(probe)) {
		return probe.audio.map((track, index) => ({
			label: audioTrackName(track, index, t),
			detail: audioTrackDetail(track, t),
			converted: transcoded.has(index) || (index === params.audioIndex && params.decision?.audio.mode === "transcode")
		}))
	}

	if (nativeAudio !== null && nativeAudio.length >= 2) {
		return nativeAudio.map((track, index) => ({
			label:
				trackLanguageName(track.language, i18n.language) ??
				(track.label.length > 0 ? track.label : t("playerTrackNumber", { number: index + 1 })),
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
	tooltipContainer,
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
	// The element the player takes fullscreen, which its tooltips portal into.
	tooltipContainer: HTMLElement | null
	onOpenChange: (open: boolean) => void
}) {
	const { t, i18n } = useTranslation(["preview", "videos"])
	const [open, setOpen] = useState(false)
	const audio = useAudioOptions({ probe, nativeAudio, decision, audioIndex, size, open })
	const hasSubtitles = subtitles.options.length > 0
	const empty = audio.length === 0 && !hasSubtitles

	// A menu whose options went while it was open closes with them, so whoever tracks it hears so.
	if (empty && open) {
		setOpen(false)
	}

	useClosesOnUnmount(open, onOpenChange)

	if (empty) {
		return null
	}

	// Named by what it holds.
	const label =
		audio.length > 0 && hasSubtitles
			? t("videos:playerTracks")
			: audio.length > 0
				? t("videos:playerAudio")
				: t("previewMediaSubtitles")

	return (
		<DropdownMenu
			onOpenChange={next => {
				setOpen(next)
				onOpenChange(next)
			}}
		>
			<MediaTooltip
				label={label}
				container={tooltipContainer}
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
			</MediaTooltip>
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
						<DropdownMenuLabel className={SECTION_LABEL_CLASS}>{t("videos:playerAudio")}</DropdownMenuLabel>
						{audio.map((option, index) => (
							<DropdownMenuRadioItem
								key={index}
								value={String(index)}
							>
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="truncate">{option.label}</span>
									{option.detail === null ? null : (
										<span className="truncate text-xs text-muted-foreground">{option.detail}</span>
									)}
								</span>
								{option.converted ? (
									<span
										title={t("videos:playerAudioTranscoded")}
										className="shrink-0 text-xs text-muted-foreground"
									>
										<span aria-hidden="true">◆ </span>
										{t("previewMediaAudioConverted")}
									</span>
								) : null}
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
						<DropdownMenuLabel className={SECTION_LABEL_CLASS}>{t("previewMediaSubtitles")}</DropdownMenuLabel>
						<DropdownMenuRadioItem value="off">{t("previewMediaSubtitlesOff")}</DropdownMenuRadioItem>
						{subtitles.options.map(option => (
							<DropdownMenuRadioItem
								key={option.id}
								value={option.id}
								disabled={option.unplayable}
							>
								<span className="truncate">
									{option.unplayable
										? t("previewMediaSubtitleUnplayable", { name: subtitleLabel(option, i18n.language, key => t(key)) })
										: subtitles.failed && option.id === subtitles.selected
											? t("previewMediaSubtitleUnreadable", {
													name: subtitleLabel(option, i18n.language, key => t(key))
												})
											: subtitleLabel(option, i18n.language, key => t(key))}
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
	tooltipContainer,
	onOpenChange
}: {
	chapters: readonly StageChapter[]
	media: HTMLMediaElement | null
	container: HTMLElement | null
	// The element the player takes fullscreen, which its tooltips portal into.
	tooltipContainer: HTMLElement | null
	onOpenChange: (open: boolean) => void
}) {
	const { t } = useTranslation("preview")
	const [open, setOpen] = useState(false)

	useClosesOnUnmount(open, onOpenChange)

	return (
		<DropdownMenu
			onOpenChange={next => {
				setOpen(next)
				onOpenChange(next)
			}}
		>
			<MediaTooltip
				label={t("previewMediaChapters")}
				container={tooltipContainer}
			>
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
			</MediaTooltip>
			<DropdownMenuContent
				side="top"
				align="end"
				container={container ?? undefined}
				className={cn(
					MEDIA_GLASS_TONE_CLASS,
					"max-h-[min(28rem,var(--available-height))] w-auto max-w-80 min-w-44 before:backdrop-saturate-100"
				)}
			>
				<ChapterItems
					chapters={chapters}
					media={media}
				/>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

// Mounted only while the menu is open, so the playhead re-renders nothing otherwise. A radio list: the chapter playing
// is the checked one.
function ChapterItems({ chapters, media }: { chapters: readonly StageChapter[]; media: HTMLMediaElement | null }) {
	const { t } = useTranslation(["preview", "common"])
	const current = chapterAt(chapters, useMediaCurrentTime(media))

	return (
		<DropdownMenuRadioGroup
			value={current === null ? "" : String(chapters.indexOf(current))}
			onValueChange={(next: string) => {
				const chapter = chapters[Number(next)]

				if (media !== null && chapter !== undefined) {
					seekMedia(media, chapter.start)
				}
			}}
		>
			<DropdownMenuLabel className={SECTION_LABEL_CLASS}>{t("previewMediaChapters")}</DropdownMenuLabel>
			{chapters.map((chapter, index) => (
				<DropdownMenuRadioItem
					key={index}
					value={String(index)}
					className="gap-3"
				>
					<span className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular-nums">{index + 1}</span>
					<span className="min-w-0 flex-1 truncate">
						{chapter.title !== null && chapter.title.length > 0
							? chapter.title
							: t("common:mediaChapter", { number: index + 1 })}
					</span>
					<span className="text-xs text-muted-foreground tabular-nums">{formatSecondsToMediaClock(chapter.start)}</span>
				</DropdownMenuRadioItem>
			))}
		</DropdownMenuRadioGroup>
	)
}

// The section headings: AUDIO, SUBTITLES, CHAPTERS.
const SECTION_LABEL_CLASS = "text-xs font-medium"

// A menu that goes away while open (its tracks or chapters went with a new probe) still reports itself closed, so the
// controls it held shown can hide again.
function useClosesOnUnmount(open: boolean, onOpenChange: (open: boolean) => void): void {
	useEffect(() => {
		if (!open) {
			return
		}

		return () => {
			onOpenChange(false)
		}
	}, [open, onOpenChange])
}
