import { useId, useState } from "react"
import { useTranslation } from "react-i18next"
import { useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import { CheckIcon, PlayIcon, RotateCcwIcon } from "lucide-react"
import { formatSecondsToMediaClock } from "@filen/shared"
import { languageName } from "@filen/shared/videos"
import { log } from "@/lib/log"
import { useNowMinute } from "@/lib/useNowMinute"
import { useTitleWatch } from "@/features/videos/hooks/useTitleWatch"
import { defaultAudioIndex } from "@/features/videos/lib/player/audioChoice.logic"
import { watchState } from "@/features/videos/lib/watchState"
import {
	defaultVersion,
	detailSlots,
	moviePrimaryAction,
	showsVersionPicker,
	durationText,
	timeLeftText,
	versionKeys,
	type DetailHeaderMode,
	type LadderBadge,
	type Slot
} from "@/features/videos/lib/titleDetail.logic"
import { subtitleTracksOf } from "@/features/videos/lib/player/subtitles.logic"
import { channelLabel } from "@/features/videos/lib/player/trackLabels.logic"
import { useDetailProbeQuery, useLadderBadgesQuery, useNfoQuery, useStoredProbesQuery } from "@/features/videos/queries/detail"
import { DetailHeader, ResumeBar, SlotFade } from "@/features/videos/components/detail/detailHeader"
import { ExtrasShelf } from "@/features/videos/components/detail/extrasShelf"
import { TitleMenu } from "@/features/videos/components/detail/titleMenu"
import { DetailSynopsis } from "@/features/videos/components/detail/detailText"
import { titleSubject } from "@/features/videos/lib/corrections.logic"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { VideoPartView, VideoTitleDetail, VideoVersionView } from "@/workers/videoIndex/view.logic"

// The movie page, also used for another video: header, Play / Resume / Start over / Mark watched, the version,
// audio and subtitle choices handed to the player, the NFO's synopsis and cast, and the extras shelf.

const BADGE_KEY = {
	direct: "detailBadgeDirect",
	remux: "detailBadgeRemux",
	unsupported: "detailBadgeUnsupported"
} as const satisfies Record<LadderBadge, string>

const AUTO = "auto"

interface PickOption {
	value: string
	label: string
}

function PickSelect({
	label,
	options,
	value,
	onChange,
	pending
}: {
	label: string
	options: readonly PickOption[]
	value: string
	onChange: (value: string) => void
	pending: boolean
}) {
	const id = useId()

	return (
		<div className="flex items-center gap-2">
			<span
				id={id}
				className="text-sm text-muted-foreground"
			>
				{label}
			</span>
			<Select
				items={options}
				value={value}
				disabled={pending || options.length < 2}
				onValueChange={next => {
					if (next !== null) {
						onChange(next)
					}
				}}
			>
				<SelectTrigger
					size="sm"
					aria-labelledby={id}
					className="max-w-64 min-w-32"
				>
					{pending ? <span className="invisible">{label}</span> : <SelectValue />}
				</SelectTrigger>
				<SelectContent>
					<SelectGroup>
						{options.map(option => (
							<SelectItem
								key={option.value}
								value={option.value}
							>
								{option.label}
							</SelectItem>
						))}
					</SelectGroup>
				</SelectContent>
			</Select>
		</div>
	)
}

function versionsOf(detail: Extract<VideoTitleDetail, { kind: "movie" | "other" }>): VideoVersionView[] {
	if (detail.kind === "movie") {
		return detail.versions
	}

	return detail.part === null ? [] : [{ label: "", parts: [detail.part] }]
}

export function MovieDetail({
	detail,
	headerMode,
	onBack,
	onEdit
}: {
	detail: Extract<VideoTitleDetail, { kind: "movie" | "other" }>
	headerMode: DetailHeaderMode
	onBack: () => void
	onEdit: () => void
}) {
	const { t } = useTranslation("videos")
	const navigate = useNavigate()
	const headingId = useId()
	const extrasId = useId()
	const { entries } = useTitleWatch(detail)
	// "Ends at" moves on with the clock while the page stays open.
	const now = useNowMinute()
	const title = detail.title
	const versions = versionsOf(detail)
	const keys = versionKeys(versions)
	const [picked, setPicked] = useState<number | null>(null)
	const [audioPick, setAudioPick] = useState<{ key: string; index: number } | null>(null)
	const [subPick, setSubPick] = useState<{ key: string; value: string } | null>(null)
	const selected = Math.min(picked ?? defaultVersion(versions, entries), Math.max(0, versions.length - 1))
	const part: VideoPartView | null = versions[selected]?.parts[0] ?? null
	const key = part?.file.stableUuid ?? null
	const probeQuery = useDetailProbeQuery(part)
	const nfoRef = detail.kind === "movie" ? (detail.nfo ?? part?.nfo ?? null) : (part?.nfo ?? null)
	const nfoQuery = useNfoQuery(nfoRef)
	const nfo = nfoQuery.data ?? null
	// An NFO the index knows of holds its fields' room until it is read; none known, nothing is reserved.
	const nfoPending = nfoRef !== null && nfoQuery.isPending
	const otherUuids = versions.flatMap(version =>
		version.parts[0] === undefined || version.parts[0] === part ? [] : [version.parts[0].file.uuid]
	)
	const stored = useStoredProbesQuery(showsVersionPicker(versions) ? otherUuids : []).data
	const probe = part === null || part.unsupported ? null : probeQuery.isError ? null : probeQuery.data
	const badgeInputs = versions.flatMap(version => {
		const first = version.parts[0]
		const known = first === undefined ? undefined : first === part ? (probe ?? undefined) : stored?.get(first.file.uuid)

		return first === undefined || known === undefined ? [] : [{ uuid: first.file.uuid, size: first.file.size, probe: known }]
	})
	const badges = useLadderBadgesQuery(showsVersionPicker(versions) ? badgeInputs : [], null).data
	const entry = key === null ? undefined : entries.get(key)
	const action = key === null ? null : moviePrimaryAction(key, entry)
	const resumeSec = action?.kind === "resume" ? action.positionSec : 0
	const slots = detailSlots({
		probe,
		part,
		height: title.height,
		nfoRuntimeMinutes: nfo?.runtimeMinutes ?? null,
		resumeSec,
		now
	})
	const watched = keys.some(item => entries.get(item)?.state.played === true)
	const playable = part !== null && !part.unsupported
	const audioIndex =
		probe === null || probe === undefined
			? -1
			: audioPick?.key === key
				? audioPick.index
				: defaultAudioIndex({
						probe,
						rememberedLang: null,
						userLanguages: typeof navigator === "undefined" ? [] : navigator.languages
					})
	const subValue = subPick?.key === key ? subPick.value : AUTO
	const subtitleTracks = part === null || probe === undefined ? [] : subtitleTracksOf(part, probe)

	function play(from: "start" | null): void {
		if (key === null) {
			return
		}

		void navigate({
			to: "/videos/watch/$uuid",
			params: { uuid: title.id },
			search: {
				file: key,
				...(from === null ? {} : { from }),
				...(audioPick?.key === key ? { audio: audioPick.index } : {}),
				...(subValue === AUTO ? {} : { sub: subValue })
			}
		})
	}

	function setWatched(next: boolean): void {
		const work = next ? watchState.markWatched({ stableUuids: keys }) : watchState.markUnwatched({ stableUuids: keys })

		work.catch((e: unknown) => {
			log.warn("videos.detail", "watch-state change failed", e)
			toast.error(t("videosCardWatchStateFailed"))
		})
	}

	const metaLine: string[] = []

	if (title.year > 0) {
		metaLine.push(String(title.year))
	}

	const mpaaSlot: Slot<string> = nfoPending
		? { state: "pending" }
		: nfo?.mpaa === undefined
			? { state: "empty" }
			: { state: "ready", value: nfo.mpaa }
	const spokenMeta = [
		...metaLine,
		...(slots.runtimeSec.state === "ready" ? [durationText(slots.runtimeSec.value, t)] : []),
		...(mpaaSlot.state === "ready" ? [mpaaSlot.value] : []),
		...(slots.badges.state === "ready" ? slots.badges.value : [])
	]

	const versionOptions: PickOption[] = versions.map((version, index) => {
		const first = version.parts[0]
		const badge = first === undefined ? undefined : badges?.get(first.file.uuid)
		const label = version.label.length > 0 ? version.label : t("detailVersionNumber", { number: index + 1 })

		return { value: String(index), label: badge === undefined ? label : `${label} · ${t(BADGE_KEY[badge])}` }
	})
	const audioOptions: PickOption[] =
		probe === null || probe === undefined
			? []
			: probe.audio.map((track, index) => ({
					value: String(index),
					label: [languageName(track.lang) ?? t("playerTrackNumber", { number: index + 1 }), channelLabel(track.ch, k => t(k))]
						.filter(item => item !== null)
						.join(" ")
				}))
	const subtitleOptions: PickOption[] = [
		{ value: AUTO, label: t("subtitleAuto") },
		{ value: "off", label: t("subtitleOff") },
		...subtitleTracks
			.filter(track => track.unavailable === null)
			.map(track => ({
				value: track.id,
				label: [
					languageName(track.lang) ?? t("subtitleUnknownLanguage"),
					track.forced ? t("subtitleForced") : null,
					track.hi ? t("subtitleSdh") : null
				]
					.filter(item => item !== null)
					.join(" · ")
			}))
	]
	const menu = (
		<TitleMenu
			title={title}
			overrideKey={titleSubject(detail).key}
			fileStableUuid={key}
			versions={showsVersionPicker(versions) ? versionOptions : null}
			version={String(selected)}
			onVersion={value => {
				setPicked(Number(value))
			}}
			onEdit={onEdit}
		/>
	)

	return (
		<>
			<DetailHeader
				mode={headerMode}
				titleId={title.id}
				title={title.title}
				headingId={headingId}
				eyebrow={detail.kind === "movie" ? t("detailEyebrowMovie") : t("detailEyebrowOther")}
				onBack={onBack}
				menu={menu}
				meta={
					<>
						{/* One text run for assistive technology; the line below is its visual form, with reserved slots. */}
						<p className="sr-only">{spokenMeta.join(" · ")}</p>
						<p
							aria-hidden="true"
							className="flex min-h-5 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground tabular-nums"
						>
							{metaLine.length > 0 ? <span>{metaLine.join(" · ")}</span> : null}
							<SlotFade
								slot={slots.runtimeSec}
								placeholder="0h 00m"
							>
								{metaLine.length > 0 ? "· " : ""}
								{slots.runtimeSec.state === "ready" ? durationText(slots.runtimeSec.value, t) : null}
							</SlotFade>
							<SlotFade
								slot={mpaaSlot}
								placeholder="· PG-13"
							>
								· {mpaaSlot.state === "ready" ? mpaaSlot.value : null}
							</SlotFade>
							<SlotFade
								slot={slots.badges}
								placeholder="4K"
							>
								<span className="inline-flex flex-wrap gap-1">
									{slots.badges.state === "ready"
										? slots.badges.value.map(badge => (
												<Badge
													key={badge}
													variant="outline"
												>
													{badge}
												</Badge>
											))
										: null}
								</span>
							</SlotFade>
						</p>
						<p className="min-h-5 text-sm text-muted-foreground tabular-nums">
							<SlotFade
								slot={slots.endsAtMs}
								placeholder="Ends at 00:00"
							>
								{slots.endsAtMs.state === "ready"
									? t("videosHomeEndsAt", {
											time: new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(slots.endsAtMs.value)
										})
									: null}
							</SlotFade>
						</p>
					</>
				}
				actions={
					<>
						<div className="flex flex-wrap items-center gap-2">
							<Button
								disabled={!playable}
								onClick={() => {
									play(null)
								}}
							>
								<PlayIcon
									data-icon="inline-start"
									className="fill-current"
								/>
								{action?.kind === "resume"
									? t("videosHomeResume", { time: formatSecondsToMediaClock(action.positionSec) })
									: t("videosHomePlay")}
							</Button>
							{action?.kind === "resume" ? (
								<Button
									variant="outline"
									onClick={() => {
										play("start")
									}}
								>
									<RotateCcwIcon data-icon="inline-start" />
									{t("playerStartOver")}
								</Button>
							) : null}
							{part?.unsupported === true ? null : (
								<Button
									variant="outline"
									onClick={() => {
										setWatched(!watched)
									}}
								>
									<CheckIcon data-icon="inline-start" />
									{watched ? t("videosCardMarkUnwatched") : t("videosCardMarkWatched")}
								</Button>
							)}
						</div>
						{action?.kind === "resume" ? (
							<ResumeBar
								progress={action.progress}
								label={timeLeftText(action.remainingSec, t)}
							/>
						) : null}
					</>
				}
			/>
			<div className="flex flex-col gap-6 px-4 pb-10 md:px-6">
				<Separator />
				{playable ? (
					<div className="flex min-h-8 flex-wrap items-center gap-x-5 gap-y-2">
						{showsVersionPicker(versions) ? (
							<PickSelect
								label={t("detailVersion")}
								options={versionOptions}
								value={String(selected)}
								pending={false}
								onChange={value => {
									setPicked(Number(value))
								}}
							/>
						) : null}
						{slots.tracks.state === "empty" ? null : (
							<>
								<PickSelect
									label={t("playerAudio")}
									options={audioOptions}
									value={String(audioIndex)}
									pending={slots.tracks.state === "pending"}
									onChange={value => {
										if (key !== null) {
											setAudioPick({ key, index: Number(value) })
										}
									}}
								/>
								<PickSelect
									label={t("playerSubtitles")}
									options={subtitleOptions}
									value={subValue}
									pending={slots.tracks.state === "pending"}
									onChange={value => {
										if (key !== null) {
											setSubPick({ key, value })
										}
									}}
								/>
							</>
						)}
					</div>
				) : (
					<p className="text-sm text-muted-foreground">
						{t("videosCardUnsupported", { container: (part?.container ?? title.container).toUpperCase() })}
					</p>
				)}
				<DetailSynopsis
					plot={nfo?.plot ?? null}
					cast={nfo?.cast ?? []}
					pending={nfoPending}
				/>
				{detail.kind === "movie" ? (
					<ExtrasShelf
						titleId={title.id}
						extras={detail.extras}
						headingId={extrasId}
					/>
				) : null}
			</div>
		</>
	)
}
