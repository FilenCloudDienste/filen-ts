import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import type { TFunction } from "i18next"
import { useQuery } from "@tanstack/react-query"
import { useNavigate, useRouter } from "@tanstack/react-router"
import { ChevronRightIcon, ListVideoIcon } from "lucide-react"
import {
	itemKey,
	mergeSegments,
	segmentsFromChapters,
	seriesKey,
	type CueStore,
	type SegmentKind,
	type SkipSegment
} from "@filen/shared/videos"
import { formatSecondsToMediaClock } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { VideoStage } from "@/components/media/video/videoStage"
import { StageIconButton } from "@/components/media/video/stageButton"
import { StageCenterCard, StageNotice, StagePanel } from "@/components/media/video/stageCards"
import { StageSettingsMenu, type SettingsMenuItem } from "@/components/media/video/settingsMenu"
import { SubtitleDelayPanel, SubtitleStylePanel } from "@/components/media/video/subtitlePanels"
import { useStageMediaSession } from "@/components/media/video/useStageMediaSession"
import type { StageChapter } from "@/components/media/video/stage.logic"
import { clampSubtitleDelay, formatSubtitleDelay } from "@/lib/media/subtitles/subtitleStyle.logic"
import type { VideoKeyAction } from "@/lib/media/videoKeys.logic"
import { toggleMediaMuted, useMediaVolumeStore } from "@/lib/media/mediaVolume"
import { seekMedia } from "@/lib/media/useMediaState"
import { isVideoNativeFullscreen } from "@/lib/media/fullscreen"
import { sdkApi } from "@/lib/sdk/client"
import { runOp } from "@/lib/actions/outcome"
import { noDiskPersister } from "@/queries/persist"
import { useIsOnline } from "@/lib/useIsOnline"
import { useVideoLibrary, videoTitleDetailQueryKey } from "@/features/videos/queries/library"
import { useCatalogTitleQuery } from "@/features/videos/queries/catalog"
import { log } from "@/lib/log"
import { videoLibrary } from "@/features/videos/lib/index"
import { watchState } from "@/features/videos/lib/watchState"
import { probeService } from "@/features/videos/lib/probeService"
import { PROBE_RANK } from "@/features/videos/lib/probeService.logic"
import { PlayerController } from "@/features/videos/lib/player/playerController"
import { RESUME_PILL_MS } from "@/features/videos/lib/player/resume.logic"
import { cancelPrewarm, prewarmPlayback } from "@/lib/media/playback/sources"
import { playbackEnvironment } from "@/lib/media/playback/capabilities"
import { SkipPromptTracker, creditsStart } from "@/features/videos/lib/player/skipPrompts.logic"
import { StillWatchingCounter, autoAdvance, upNextState, upNextTimingFor } from "@/features/videos/lib/player/upNextFlow.logic"
import {
	adjacentEpisode,
	allEpisodes,
	episodeCode,
	nextUnwatchedInSeason,
	resolveWatchTarget,
	type WatchItemTarget
} from "@/features/videos/lib/player/watchTarget.logic"
import { SidecarReader, readSubtitleEncoding, saveSubtitleEncoding } from "@/features/videos/lib/player/sidecarReader"
import {
	decodeRememberedSubtitle,
	encodeRememberedSubtitle,
	resolveSubtitleChoice,
	subtitleTracksOf,
	embeddedTrackNumber,
	restoreSubtitleTrack,
	subtitleChoiceFor,
	type ItemSubtitleChoice,
	type PlayerSubtitleTrack,
	type SubtitleChoice
} from "@/features/videos/lib/player/subtitles.logic"
import { EpisodesPanel } from "@/features/videos/components/player/episodesPanel"
import { UpNextCard } from "@/features/videos/components/player/upNextCard"
import { PlayerTracks } from "@/features/videos/components/player/playerTracks"
import { audioTrackNotice, subtitleTrackNotice } from "@/features/videos/lib/player/trackLabels.logic"
import { useUpNextStill } from "@/features/videos/components/player/useTitleStill"
import type { VideoTitleDetail } from "@/workers/videoIndex/view.logic"
import type { VideosKey } from "@/lib/i18n"
import { UP_NEXT_CHECK_INTERVAL_MS, deriveWatchState } from "@filen/shared/videos"

// /videos/watch/$uuid: the Videos player. Plays one item of a title on the stage's one <video> element and
// moves through a series' episodes by swapping what it plays (the route's `file` search changes; nothing
// remounts). Skip prompts, Up Next, still watching and post-play run off a 700 ms check of the playhead, so
// nothing re-renders as playback runs.

export interface WatchSearch {
	// Stable uuid of the file to play (any part of any version); the title's own choice when absent.
	file?: string
	// "start": from the beginning instead of the resume point.
	from?: "start"
	// The audio track index and subtitle choice ("off" or a track id) picked on the detail page, for `file`.
	audio?: number
	sub?: string
}

type Panel = "episodes" | "style" | "delay" | "cast" | null

// What post-play offers next: an episode of the same series, or another movie from the same library directory.
type PostPlayNext = { kind: "episode"; target: WatchItemTarget } | { kind: "title"; id: string; name: string }

type CenterCard = { kind: "stillWatching" } | { kind: "blocked" } | { kind: "postPlay"; next: PostPlayNext | null } | null

interface LoadedCues {
	key: string
	store: CueStore | null
	encoding: string | null
}

// Up Next for one item: shown once, dismissed ("Watch credits") for the rest of it.
interface UpNextView {
	key: string
	visible: boolean
	shown: boolean
	dismissed: boolean
}

function upNextFor(key: string): UpNextView {
	return { key, visible: false, shown: false, dismissed: false }
}

// How the item now opening was chosen: autoplay counts toward "still watching", the user resets it.
interface Advance {
	key: string
	how: "user" | "auto" | "ask"
}

const SKIP_LABELS: Readonly<Record<SegmentKind, VideosKey>> = {
	intro: "skipIntro",
	outro: "skipCredits",
	recap: "skipRecap",
	preview: "skipPreview",
	commercial: "skipCommercial",
	intermission: "skipIntermission"
}

const SUBTITLE_NOTICE_MS = 1500

function titleLine(t: TFunction<"videos">, target: WatchItemTarget, versions: number): string {
	if (target.episode !== null) {
		const code = episodeCode(target.episode)

		if (code.length === 0) {
			return target.episode.title.length > 0 ? `${target.titleName} · ${target.episode.title}` : target.titleName
		}

		return target.episode.title.length > 0
			? t("playerTitleEpisode", { series: target.titleName, code, title: target.episode.title })
			: t("playerTitleEpisodeShort", { series: target.titleName, code })
	}

	return versions > 1 && target.versionLabel.length > 0
		? t("playerTitleVersion", { title: target.titleName, version: target.versionLabel })
		: target.titleName
}

// The detail page's subtitle pick holds for the item it was made for.
function initialSubtitleChoice(search: WatchSearch): ItemSubtitleChoice {
	if (search.sub === undefined || search.file === undefined) {
		return { key: null, choice: { kind: "auto" } }
	}

	return { key: search.file, choice: search.sub === "off" ? { kind: "off" } : { kind: "track", id: search.sub } }
}

function versionCount(detail: VideoTitleDetail | null): number {
	return detail?.kind === "movie" ? detail.versions.length : 1
}

export function WatchScreen({ titleId, search }: { titleId: string; search: WatchSearch }) {
	const { t } = useTranslation("videos")
	const navigate = useNavigate()
	const router = useRouter()
	const library = useVideoLibrary()
	const titleQuery = useCatalogTitleQuery(titleId)
	const known = titleQuery.data !== undefined && titleQuery.data !== null
	// A deep link opened before the library finished its first scan: the title may still turn up.
	const scanning = library.roots.some(root => root.walking || root.state === "loading")
	const detailQuery = useQuery({
		queryKey: videoTitleDetailQueryKey(titleId),
		queryFn: () => runOp<VideoTitleDetail | null>(sdkApi.videoTitleDetail(titleId)),
		staleTime: Infinity,
		persister: noDiskPersister,
		enabled: library.loaded && known
	})
	const detail = detailQuery.data ?? null
	const target = detail === null ? null : resolveWatchTarget(detail, search.file ?? null)
	const [controller] = useState(() => new PlayerController())
	const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
	const doc = useSyncExternalStore(watchState.subscribe, () => watchState.getSnapshot().doc)
	const [video, setVideo] = useState<HTMLVideoElement | null>(null)
	const [reader] = useState(() => new SidecarReader())
	const [counter] = useState(() => new StillWatchingCounter())
	// The subtitle choice holds for the item it was made on; the next one starts from Smart again, so the series'
	// remembered language applies.
	const [choiceState, setChoiceState] = useState<ItemSubtitleChoice>(() => initialSubtitleChoice(search))
	const [encodings, setEncodings] = useState<ReadonlyMap<string, string | null>>(new Map())
	const [loadedCues, setLoadedCues] = useState<LoadedCues | null>(null)
	// The notice over the picture (the subtitle delay, a track the keys switched to, a sidecar that would not load). A new
	// object per notice, so the same text shown again (a second track of the same name) starts its time over.
	const [subtitleNotice, setSubtitleNotice] = useState<{ readonly text: string } | null>(null)
	const [delayOverride, setDelayOverride] = useState<{ key: string; seconds: number } | null>(null)
	const [panel, setPanel] = useState<Panel>(null)
	const [tracksOpen, setTracksOpen] = useState(false)
	const [controlsVisible, setControlsVisible] = useState(true)
	const [skipState, setSkipState] = useState<{ epoch: number; segment: SkipSegment | null }>({ epoch: -1, segment: null })
	const [upNextStored, setUpNextStored] = useState<UpNextView>(upNextFor(""))
	const [card, setCard] = useState<CenterCard>(null)
	const [pillHiddenEpoch, setPillHiddenEpoch] = useState(-1)
	const [edlSegments, setEdlSegments] = useState<{ uuid: string; segments: SkipSegment[] } | null>(null)
	const online = useIsOnline()
	const muted = useMediaVolumeStore(state => state.muted)
	const advanceRef = useRef<Advance | null>(null)
	const targetRef = useRef<WatchItemTarget | null>(null)
	const subtitleRef = useRef<PlayerSubtitleTrack | null>(null)
	// The track C brings back after turning subtitles off.
	const lastShown = useRef<PlayerSubtitleTrack | null>(null)
	const endedRef = useRef<() => void>(() => undefined)
	const upNextRef = useRef<UpNextView>(upNextFor(""))
	const trackerRef = useRef<{ key: string; tracker: SkipPromptTracker } | null>(null)
	const prewarmed = useRef<string | null>(null)
	const autoplayFired = useRef<string | null>(null)
	const targetKey = target?.key ?? null
	const versions = versionCount(detail)
	const next = detail === null || target === null ? null : adjacentEpisode(detail, target, 1)
	const previous = detail === null || target === null ? null : adjacentEpisode(detail, target, -1)
	const episodes = detail === null ? [] : allEpisodes(detail, target?.versionLabel ?? null)
	const probe = snap.target?.key === targetKey ? snap.probe : null
	const part = target?.parts[snap.part] ?? target?.parts[0] ?? null
	const subtitleTracks = part === null ? [] : subtitleTracksOf(part, probe)
	const seriesPrefs = target?.seriesDirUuid === null || target === null ? undefined : doc.series[seriesKey(target.seriesDirUuid)]
	const audioLang = probe?.audio[snap.audioIndex]?.lang ?? null
	const choice = subtitleChoiceFor(choiceState, targetKey)
	const subtitle = resolveSubtitleChoice({
		choice,
		tracks: subtitleTracks,
		audioLang,
		userLanguages: typeof navigator === "undefined" ? [] : navigator.languages,
		remembered: decodeRememberedSubtitle(seriesPrefs?.sl?.v)
	})
	const embeddedTrack = embeddedTrackNumber(subtitle)
	const embeddedCues = embeddedTrack === null ? null : controller.embeddedCues(embeddedTrack, snap.embeddedVersion)
	const subtitleUuid = subtitle?.file?.uuid ?? null
	const encodingPicked = subtitleUuid !== null && encodings.has(subtitleUuid)
	const encodingChoice = subtitleUuid === null ? null : (encodings.get(subtitleUuid) ?? null)
	const cuesKey = subtitleUuid === null ? null : `${subtitleUuid}:${encodingChoice ?? ""}`
	const cues = cuesKey !== null && loadedCues?.key === cuesKey ? loadedCues : null
	const cuesLoading = cuesKey !== null && cues === null
	const duration = probe?.durationSec ?? 0
	const edlRef = part?.edl ?? null
	const chapterSegments = segmentsFromChapters(
		(probe?.chapters ?? []).map(chapter => ({ start: chapter.t, end: chapter.end, title: chapter.title, skipType: chapter.skipType })),
		duration
	)
	const segments = mergeSegments(
		[chapterSegments, edlRef !== null && edlSegments?.uuid === edlRef.uuid ? edlSegments.segments : []],
		duration
	)
	const segmentsKey = segments.map(segment => `${String(segment.start)}-${String(segment.end)}-${segment.kind}`).join(",")
	const credits = creditsStart(segments, duration)
	const timing = upNextTimingFor({
		hasNext: next !== null,
		isEpisode: target?.kind === "episode",
		part: snap.part,
		parts: target?.parts.length ?? 1,
		duration,
		creditsStart: credits
	})
	const upNext = upNextStored.key === targetKey ? upNextStored : upNextFor(targetKey ?? "")
	const skipPrompt = skipState.epoch === snap.epoch ? skipState.segment : null
	const storedDelaySeconds = target === null ? 0 : (doc.items[itemKey(target.key)]?.o?.subMs ?? 0) / 1000
	const delay = delayOverride !== null && delayOverride.key === targetKey ? delayOverride.seconds : storedDelaySeconds
	const resumePill = snap.resumedAt !== null && pillHiddenEpoch !== snap.epoch
	const display = target === null ? "" : titleLine(t, target, versions)
	const nextFile = next?.parts[0]?.file ?? null
	const still = useUpNextStill({
		titleId,
		title: target?.titleName ?? "",
		fileUuid: nextFile?.uuid ?? null,
		enabled: upNext.visible && next !== null
	})
	const nextMinutes = nextFile === null ? null : (probeService.peek(nextFile.uuid)?.probe?.durationSec ?? null)
	const chapters: StageChapter[] = (probe?.chapters ?? []).map(chapter => ({ start: chapter.t, title: chapter.title }))

	// Opens what the user picked: the route's file changes, and the effect below opens it on the same element.
	function playItem(item: WatchItemTarget, how: Advance["how"]): void {
		if (how === "auto") {
			counter.note("autoplay")
		} else if (how === "user") {
			counter.note("interaction")
		}

		advanceRef.current = { key: item.key, how }
		setCard(how === "ask" ? { kind: "stillWatching" } : null)
		setPanel(current => (current === "episodes" ? null : current))
		void navigate({ to: "/videos/watch/$uuid", params: { uuid: titleId }, search: { file: item.key }, replace: true })
	}

	function playNext(how: "user" | "auto"): void {
		if (next === null) {
			return
		}

		if (how === "auto" && autoAdvance({ hasNext: true, autoplay: true, consecutiveAutoplays: counter.value }) === "askStillWatching") {
			playItem(next, "ask")

			return
		}

		playItem(next, how)
	}

	// The season's next unwatched episode (from what is in memory), or the next unwatched movie from the same library
	// directory (asked of the library's worker).
	async function postPlayNext(current: WatchItemTarget): Promise<PostPlayNext | null> {
		if (current.kind === "episode") {
			const played = (episode: WatchItemTarget): boolean => {
				const first = episode.parts[0]?.file

				return first !== undefined && deriveWatchState({ rec: doc.items[itemKey(episode.key)], file: first }).played
			}
			const episode = nextUnwatchedInSeason(episodes, current, played)

			return episode === null ? null : { kind: "episode", target: episode }
		}

		if (current.kind !== "movie") {
			return null
		}

		const movie = await videoLibrary.nextMovie(titleId).catch((e: unknown) => {
			log.warn("videos.player", "next movie unavailable", e)

			return null
		})

		return movie === null ? null : { kind: "title", id: movie.id, name: movie.title }
	}

	function playPostPlayNext(choice: PostPlayNext): void {
		if (choice.kind === "episode") {
			playItem(choice.target, "user")

			return
		}

		counter.note("interaction")
		setCard(null)
		void navigate({ to: "/videos/watch/$uuid", params: { uuid: choice.id }, search: {}, replace: true })
	}

	function goBack(): void {
		if (router.history.canGoBack()) {
			router.history.back()
		} else {
			void navigate({ to: "/videos" })
		}
	}

	function setUpNext(view: UpNextView): void {
		upNextRef.current = view
		setUpNextStored(view)
	}

	function dismissUpNext(): void {
		setUpNext({ ...upNext, visible: false, dismissed: true })
	}

	function skip(): boolean {
		const tracker = trackerRef.current?.tracker ?? null

		if (video === null || tracker === null || skipPrompt === null) {
			return false
		}

		const to = tracker.skip(video.currentTime)

		setSkipState({ epoch: snap.epoch, segment: null })

		if (to !== null) {
			seekMedia(video, to)
		}

		return true
	}

	function setChoice(picked: SubtitleChoice): void {
		setChoiceState({ key: targetKey, choice: picked })
	}

	function chooseSubtitle(picked: SubtitleChoice): void {
		setChoice(picked)

		const series = target?.seriesDirUuid ?? null

		if (series === null || picked.kind === "auto") {
			return
		}

		const track = picked.kind === "off" ? null : (subtitleTracks.find(entry => entry.id === picked.id) ?? null)

		void watchState.setSeriesLanguages({ seriesDirUuid: series, subtitle: encodeRememberedSubtitle(track) })
	}

	function changeDelay(seconds: number): void {
		const value = clampSubtitleDelay(seconds)

		if (target === null) {
			return
		}

		setDelayOverride({ key: target.key, seconds: value })
		void watchState.setSubtitleOffset({ stableUuid: target.key, subMs: Math.round(value * 1000) })
	}

	useEffect(() => {
		targetRef.current = target
		subtitleRef.current = subtitle

		if (subtitle !== null) {
			lastShown.current = subtitle
		}
	})

	useEffect(() => {
		controller.attach(video)
	}, [controller, video])

	useEffect(
		() => () => {
			reader.cancel()
			controller.dispose()
		},
		[controller, reader]
	)

	// Opens the item the route names whenever that changes; an episode swap keeps the element.
	useEffect(() => {
		const current = targetRef.current

		if (video === null || current?.key !== targetKey) {
			return
		}

		const advance = advanceRef.current?.key === current.key ? advanceRef.current : null

		advanceRef.current = null
		prewarmed.current = null
		autoplayFired.current = null
		void controller.open({
			target: current,
			start: search.from === "start" ? "start" : "resume",
			autoplay: advance?.how !== "ask",
			...(search.audio !== undefined && search.file === current.key ? { audioIndex: search.audio } : {})
		})
	}, [controller, video, targetKey, search.from, search.audio, search.file])

	// An embedded text track needs the remux rung (the controller restarts a direct stream on it).
	const subtitleKind = embeddedTrack !== null ? "embedded-text" : subtitleUuid !== null ? "sidecar" : "none"

	useEffect(() => {
		controller.setSubtitleKind(subtitleKind, embeddedTrack)
	}, [controller, subtitleKind, embeddedTrack])

	// Once Up Next shows, the next episode is readied (its stream registered, or the file opened in the remux
	// worker with its first keyframe interval read), once per item. Watch credits, a seek back before the card or
	// leaving lets it go; playing that episode takes it over.
	const upNextShown = upNext.visible
	const nextKey = next?.key ?? null
	const nextName = next?.parts[0]?.file.name ?? ""

	useEffect(() => {
		if (!upNextShown || nextKey === null) {
			return
		}

		const run = { live: true }
		// A function, so each check reads the flag anew across the awaits.
		const alive = (): boolean => run.live

		void (async () => {
			const [file] = await videoLibrary.playableFiles([nextKey])

			if (!alive() || file === undefined) {
				return
			}

			const record = await probeService.request({ uuid: file.uuid, file }, "full", { rank: () => PROBE_RANK.idle })
			const nextProbe = record?.probe ?? null

			if (alive() && nextProbe !== null) {
				prewarmPlayback({
					file,
					name: nextName,
					probe: nextProbe,
					idrOnlyStart: playbackEnvironment().browser === "firefox" && nextProbe.video?.codec === "hevc"
				})
			}
		})()

		return () => {
			run.live = false

			if (advanceRef.current?.key !== nextKey) {
				cancelPrewarm()
			}
		}
	}, [upNextShown, nextKey, nextName])

	// The resume pill goes after 8 s.
	useEffect(() => {
		if (snap.resumedAt === null) {
			return
		}

		const epoch = snap.epoch
		const timer = setTimeout(() => {
			setPillHiddenEpoch(epoch)
		}, RESUME_PILL_MS)

		return () => {
			clearTimeout(timer)
		}
	}, [snap.resumedAt, snap.epoch])

	// The part's .edl, read once.
	useEffect(() => {
		if (edlRef === null) {
			return
		}

		let live = true

		void reader.edl(edlRef).then(fromEdl => {
			if (live) {
				setEdlSegments({ uuid: edlRef.uuid, segments: fromEdl })
			}
		})

		return () => {
			live = false
		}
	}, [edlRef, reader])

	// The chosen subtitle file's cues (one read each, kept for the player's life), in its remembered encoding.
	useEffect(() => {
		const track = subtitleRef.current

		if (track === null || subtitleUuid === null || cuesKey === null) {
			return
		}

		const run = { live: true }

		void (async () => {
			const stored = encodingPicked ? encodingChoice : await readSubtitleEncoding(subtitleUuid)
			const result = await reader.subtitle(track, stored === null || stored.length === 0 ? null : stored)

			if (!run.live) {
				return
			}

			if (result.status === "ok") {
				setLoadedCues({ key: cuesKey, store: result.cues, encoding: result.encoding })
			} else {
				setLoadedCues({ key: cuesKey, store: null, encoding: null })
				setSubtitleNotice({
					text: t(
						result.status === "tooLarge"
							? "subtitleTooLarge"
							: result.status === "unreadable"
								? "subtitleUnreadable"
								: "subtitleUnavailable"
					)
				})
			}
		})()

		return () => {
			run.live = false
		}
	}, [subtitleUuid, cuesKey, encodingChoice, encodingPicked, reader, t])

	useEffect(() => {
		if (subtitleNotice === null) {
			return
		}

		const timer = setTimeout(() => {
			setSubtitleNotice(null)
		}, SUBTITLE_NOTICE_MS)

		return () => {
			clearTimeout(timer)
		}
	}, [subtitleNotice])

	// What happens when the item ends: the next episode (or still watching), else post-play.
	useEffect(() => {
		endedRef.current = () => {
			const current = targetRef.current

			if (current === null) {
				return
			}

			if (next === null) {
				void postPlayNext(current).then(choice => {
					if (targetRef.current === current) {
						setCard({ kind: "postPlay", next: choice })
					}
				})

				return
			}

			if (video !== null && isVideoNativeFullscreen(video)) {
				playItem(next, "auto")

				return
			}

			if (upNextRef.current.dismissed || card !== null) {
				setCard({ kind: "postPlay", next: { kind: "episode", target: next } })

				return
			}

			playNext("auto")
		}
	})

	useEffect(() => {
		controller.setOnEnded(() => {
			endedRef.current()
		})

		return () => {
			controller.setOnEnded(null)
		}
	}, [controller])

	// The 700 ms check: skip prompts, Up Next and its autoplay, and the next episode's probe from half time. It
	// reads this render's values through `latest`, so a re-render never restarts the clock.
	const latest = useRef({ segments, segmentsKey, timing, credits, duration, next, card, controlsVisible })

	useEffect(() => {
		latest.current = { segments, segmentsKey, timing, credits, duration, next, card, controlsVisible }
	})

	useEffect(() => {
		if (video === null || snap.phase !== "ready" || targetKey === null) {
			return
		}

		const element = video
		const epoch = snap.epoch
		const item = targetKey
		let shownSegment: SkipSegment | null = null

		function check(): void {
			if (element.readyState < HTMLMediaElement.HAVE_METADATA) {
				return
			}

			const now = latest.current
			const time = element.currentTime
			// iPhone's native fullscreen shows none of the page: no prompts or cards there, the next episode
			// starts when the file ends.
			const native = isVideoNativeFullscreen(element)
			const elementDuration = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : now.duration
			const trackerKey = `${String(epoch)}|${now.segmentsKey}`

			if (trackerRef.current?.key !== trackerKey) {
				trackerRef.current =
					now.segments.length === 0 || elementDuration <= 0
						? null
						: { key: trackerKey, tracker: new SkipPromptTracker({ segments: now.segments, duration: elementDuration }) }
			}

			const tracker = trackerRef.current?.tracker ?? null

			if (tracker !== null) {
				const view = tracker.update({ time, now: performance.now(), controlsShown: now.controlsVisible })

				if (view.jumpTo !== null) {
					seekMedia(element, view.jumpTo)
				}

				const prompt = native ? null : view.prompt

				if (prompt !== shownSegment) {
					shownSegment = prompt
					setSkipState({ epoch, segment: prompt })
				}
			}

			const previousView = upNextRef.current.key === item ? upNextRef.current : upNextFor(item)
			const state = upNextState({
				timing: native ? null : now.timing,
				position: time,
				duration: elementDuration,
				creditsStart: now.credits,
				dismissed: previousView.dismissed,
				shown: previousView.shown
			})

			if (state.visible !== previousView.visible) {
				const view = { ...previousView, visible: state.visible, shown: previousView.shown || state.visible }

				upNextRef.current = view
				setUpNextStored(view)
			}

			if (state.visible && state.countdown <= 0 && !element.paused && now.card === null && autoplayFired.current !== item) {
				autoplayFired.current = item
				// Past the credits: the item counts as watched to its end.
				controller.finish()
				endedRef.current()
			}

			const upcoming = now.next

			if (upcoming !== null && prewarmed.current !== upcoming.key && elementDuration > 0 && time > elementDuration / 2) {
				prewarmed.current = upcoming.key

				void videoLibrary.playableFiles([upcoming.key]).then(([file]) => {
					if (file !== undefined) {
						void probeService.request({ uuid: file.uuid, file }, "full", { rank: () => PROBE_RANK.idle })
					}
				})
			}
		}

		check()

		const interval = setInterval(check, UP_NEXT_CHECK_INTERVAL_MS)

		return () => {
			clearInterval(interval)
		}
	}, [controller, video, snap.phase, snap.epoch, targetKey])

	// A failure while online opens the item again after 1, 2 and 4 s, then leaves the card's Retry; going offline and
	// back earns those tries again. The count lives in the controller, so each reopen doesn't restart it.
	useEffect(() => {
		if (!online) {
			controller.resetAutoRetries()

			return
		}

		const wait = snap.phase === "failed" ? controller.autoRetryDelay() : null

		if (wait === null) {
			return
		}

		const timer = setTimeout(() => {
			void controller.autoRetry()
		}, wait)

		return () => {
			clearTimeout(timer)
		}
	}, [online, snap.phase, controller])

	useStageMediaSession({
		video,
		onInteraction: () => {
			counter.note("interaction")
		},
		info: { title: display, artist: target?.episode === null ? "" : (target?.titleName ?? ""), artworkUrl: null },
		onNext:
			next === null
				? null
				: () => {
						playNext("user")
					},
		onPrevious:
			previous === null
				? null
				: () => {
						playItem(previous, "user")
					}
	})

	function handleAction(action: VideoKeyAction): boolean {
		switch (action.type) {
			case "toggleSubtitles": {
				if (subtitle !== null) {
					lastShown.current = subtitle
					chooseSubtitle({ kind: "off" })
					setSubtitleNotice({ text: subtitleTrackNotice(null, t) })

					return true
				}

				const restored = restoreSubtitleTrack(subtitleTracks, lastShown.current)

				if (restored === null) {
					return false
				}

				chooseSubtitle({ kind: "track", id: restored.id })
				setSubtitleNotice({ text: subtitleTrackNotice(restored, t) })

				return true
			}
			case "cycleSubtitles": {
				const usable = subtitleTracks.filter(track => track.unavailable === null)

				if (usable.length === 0) {
					return false
				}

				const at = subtitle === null ? -1 : usable.findIndex(track => track.id === subtitle.id)
				const following = usable[at + 1]

				if (following === undefined) {
					if (subtitle !== null) {
						lastShown.current = subtitle
					}

					chooseSubtitle({ kind: "off" })
					setSubtitleNotice({ text: subtitleTrackNotice(null, t) })
				} else {
					chooseSubtitle({ kind: "track", id: following.id })
					setSubtitleNotice({ text: subtitleTrackNotice(following, t) })
				}

				return true
			}
			case "cycleAudio": {
				const tracks = probe?.audio ?? []
				const index = (snap.audioIndex + 1) % Math.max(tracks.length, 1)
				const track = tracks[index]

				if (tracks.length < 2 || track === undefined) {
					return false
				}

				void controller.selectAudio(index)
				setSubtitleNotice({ text: audioTrackNotice(track, index, t) })

				return true
			}
			case "episodes":
				if (episodes.length < 2 || target === null) {
					return false
				}

				setPanel(current => (current === "episodes" ? null : "episodes"))

				return true
			case "skip":
				return skip()
			case "next":
				if (next === null) {
					return false
				}

				playNext("user")

				return true
			case "previous":
				if (previous === null) {
					return false
				}

				playItem(previous, "user")

				return true
			case "subtitleDelay":
				changeDelay(delay + action.seconds)
				setSubtitleNotice({ text: t("subtitleDelayNotice", { delay: formatSubtitleDelay(delay + action.seconds) }) })

				return true
			case "resetSubtitleDelay":
				changeDelay(0)
				setSubtitleNotice({ text: t("subtitleDelayNotice", { delay: formatSubtitleDelay(0) }) })

				return true
			case "confirm":
				if (upNext.visible && next !== null && card === null) {
					controller.finish()
					playNext("user")

					return true
				}

				return skip()
			case "dismiss":
				if (panel !== null) {
					setPanel(null)

					return true
				}

				if (upNext.visible) {
					dismissUpNext()

					return true
				}

				return false
			default:
				return false
		}
	}

	const failure =
		!library.loaded ||
		titleQuery.isPending ||
		(!known && scanning) ||
		(detail === null && detailQuery.isPending && known) ? undefined : !known || target === null ? (
			<FailureCard
				title={t("playerMissingTitle")}
				onBack={goBack}
			/>
		) : snap.phase === "missing" ? (
			<FailureCard
				title={t("playerMissingTitle")}
				onBack={goBack}
			/>
		) : snap.phase === "probeFailed" ? (
			<FailureCard
				title={t("playerProbeFailedTitle")}
				body={t("playerProbeFailedBody")}
				onBack={goBack}
				onRetry={() => {
					void controller.retry()
				}}
			/>
		) : snap.phase === "unsupported" ? (
			<FailureCard
				title={t("playerUnsupportedTitle")}
				body={t("playerUnsupportedBody")}
				onBack={goBack}
			/>
		) : snap.phase === "failed" ? (
			<FailureCard
				title={t("playerFailedTitle")}
				body={
					!online
						? t("playerOffline")
						: snap.playback?.failure?.trigger === "open-gop-start"
							? t("playerFailedOpenGop")
							: snap.playback?.failure?.trigger === "keyframe-interval"
								? t("playerFailedKeyframes")
								: t("playerFailedBody")
				}
				onBack={goBack}
				onRetry={() => {
					void controller.retry()
				}}
			/>
		) : undefined
	const notice = !online ? (
		<StageNotice>{t("playerOffline")}</StageNotice>
	) : snap.playback?.status === "reconnecting" ? (
		<StageNotice>{t("playerReconnecting")}</StageNotice>
	) : subtitleNotice !== null ? (
		<StageNotice className="pr-3">{subtitleNotice.text}</StageNotice>
	) : cuesLoading ? (
		<StageNotice className="pr-3">{t("subtitleLoading")}</StageNotice>
	) : resumePill && snap.resumedAt !== null && card === null ? (
		<StageNotice>
			{t("playerResumedAt", { time: formatSecondsToMediaClock(snap.resumedAt) })}
			<Button
				variant="ghost"
				size="xs"
				className="rounded-full"
				onClick={() => {
					setPillHiddenEpoch(snap.epoch)

					if (target !== null) {
						void controller.open({ target, start: "start", autoplay: true })
					}
				}}
			>
				{t("playerStartOver")}
			</Button>
		</StageNotice>
	) : null
	const centerCard =
		card === null ? (
			snap.autoplayBlocked ? (
				<StageCenterCard
					title={t("upNextBlocked", { title: display })}
					onEscape={goBack}
					actions={
						<Button
							data-primary=""
							onClick={() => {
								controller.play()
							}}
						>
							{t("upNextPlay")}
						</Button>
					}
				/>
			) : null
		) : card.kind === "stillWatching" ? (
			<StageCenterCard
				title={t("upNextStillWatching", { title: target?.titleName ?? display })}
				onEscape={goBack}
				actions={
					<>
						<Button
							data-primary=""
							onClick={() => {
								counter.note("confirm")
								setCard(null)
								controller.play()
							}}
						>
							{t("upNextContinue")}
						</Button>
						<Button
							variant="outline"
							onClick={goBack}
						>
							{t("playerBack")}
						</Button>
					</>
				}
			/>
		) : card.kind === "postPlay" ? (
			<StageCenterCard
				title={t("upNextFinished", { title: display })}
				onEscape={goBack}
				actions={
					<>
						<Button
							variant="outline"
							onClick={goBack}
						>
							{t("playerBack")}
						</Button>
						<Button
							variant={card.next === null ? "default" : "outline"}
							data-primary={card.next === null ? "" : undefined}
							onClick={() => {
								setCard(null)

								if (target !== null) {
									void controller.open({ target, start: "start", autoplay: true })
								}
							}}
						>
							{t("upNextPlayAgain")}
						</Button>
						{card.next === null ? null : (
							<Button
								data-primary=""
								onClick={() => {
									if (card.next !== null) {
										playPostPlayNext(card.next)
									}
								}}
							>
								{t("upNextNextTitle", {
									title: card.next.kind === "episode" ? titleLine(t, card.next.target, versions) : card.next.name
								})}
							</Button>
						)}
					</>
				}
			/>
		) : null
	const upNextTitle = card === null && failure === undefined && upNext.visible && next !== null ? titleLine(t, next, versions) : null
	const cornerCard =
		card !== null || failure !== undefined ? null : upNextTitle !== null && next !== null && timing !== null ? (
			<UpNextCard
				video={video}
				title={upNextTitle}
				detail={nextMinutes === null ? null : t("upNextMinutes", { minutes: Math.max(1, Math.round(nextMinutes / 60)) })}
				still={still}
				showAt={timing.showAt}
				autoplayAt={timing.autoplayAt}
				onPlay={() => {
					controller.finish()
					playNext("user")
				}}
				onDismiss={() => {
					dismissUpNext()
				}}
			/>
		) : skipPrompt !== null ? (
			<Button
				size="lg"
				className="bg-white text-black shadow-lg hover:bg-white/85"
				onClick={() => {
					skip()
				}}
			>
				{t(SKIP_LABELS[skipPrompt.kind])}
				<ChevronRightIcon data-icon="inline-end" />
			</Button>
		) : null

	return (
		<VideoStage
			title={display}
			backLabel={t("playerBack")}
			onBack={goBack}
			videoLabel={t("playerRegion", { title: display })}
			onVideo={setVideo}
			chapters={chapters}
			partLabel={
				target !== null && target.parts.length > 1 ? t("playerPart", { part: snap.part + 1, count: target.parts.length }) : null
			}
			cues={panel === "style" ? null : embeddedTrack !== null ? embeddedCues : (cues?.store ?? null)}
			cueOffset={delay}
			cueSample={panel === "style" ? t("subtitleStyleSample") : null}
			loading={failure === undefined && (snap.phase === "loading" || snap.phase === "idle" || snap.playback?.status === "restarting")}
			onRetry={() => {
				void controller.retry()
			}}
			failure={failure}
			hasNext={next !== null}
			hasPrevious={previous !== null}
			onNext={
				next === null
					? undefined
					: () => {
							playNext("user")
						}
			}
			onPrevious={
				previous === null
					? undefined
					: () => {
							playItem(previous, "user")
						}
			}
			trailing={({ phone }) => {
				const items: SettingsMenuItem[] = []

				if (phone) {
					if (previous !== null) {
						items.push({
							id: "previous",
							label: t("playerPrevious"),
							onSelect: () => {
								playItem(previous, "user")
							}
						})
					}

					if (next !== null) {
						items.push({
							id: "next",
							label: t("playerNext"),
							onSelect: () => {
								playNext("user")
							}
						})
					}

					items.push({ id: "mute", label: muted ? t("playerUnmute") : t("playerMute"), onSelect: toggleMediaMuted })

					if (video !== null && document.pictureInPictureEnabled) {
						items.push({
							id: "pip",
							label: t("playerPictureInPicture"),
							onSelect: () => {
								void video.requestPictureInPicture().catch(() => undefined)
							}
						})
					}
				}

				items.push({
					id: "style",
					label: t("subtitleStyleTitle"),
					onSelect: () => {
						setPanel("style")
					}
				})
				items.push({
					id: "delay",
					label: t("subtitleDelayTitle"),
					shortcuts: ["media.subtitleEarlier", "media.subtitleLater"],
					onSelect: () => {
						setPanel("delay")
					}
				})
				items.push({
					id: "cast",
					label: t("playerCast"),
					onSelect: () => {
						setPanel("cast")
					}
				})

				return (
					<>
						{episodes.length > 1 ? (
							<StageIconButton
								label={t("playerEpisodes")}
								pressed={panel === "episodes"}
								onClick={() => {
									setPanel(current => (current === "episodes" ? null : "episodes"))
								}}
							>
								<ListVideoIcon className="size-5" />
							</StageIconButton>
						) : null}
						<PlayerTracks
							probe={probe}
							file={part?.file ?? null}
							audioIndex={snap.audioIndex}
							decisionAudioMode={snap.playback?.decision.audio.mode ?? null}
							onAudio={index => {
								void controller.selectAudio(index)
							}}
							tracks={subtitleTracks}
							choice={choice}
							resolved={subtitle}
							onSubtitle={chooseSubtitle}
							encoding={encodingChoice}
							detectedEncoding={cues?.encoding ?? null}
							onEncoding={encoding => {
								if (subtitleUuid === null) {
									return
								}

								setEncodings(current => new Map(current).set(subtitleUuid, encoding))
								saveSubtitleEncoding(subtitleUuid, encoding)
							}}
							onStyle={() => {
								setTracksOpen(false)
								setPanel("style")
							}}
							onDelay={() => {
								setTracksOpen(false)
								setPanel("delay")
							}}
							open={tracksOpen}
							onOpenChange={setTracksOpen}
						/>
						<StageSettingsMenu
							video={video}
							items={items}
						/>
					</>
				)
			}}
			cornerCard={cornerCard}
			centerCard={centerCard}
			notice={notice}
			announcement={upNextTitle === null || timing === null ? null : t("upNextAnnounce", { title: upNextTitle })}
			sidePanel={
				panel === "episodes" && target !== null ? (
					<EpisodesPanel
						episodes={episodes}
						currentKey={target.key}
						doc={doc}
						onPick={episode => {
							playItem(episode, "user")
						}}
						onClose={() => {
							setPanel(null)
						}}
					/>
				) : panel === "style" ? (
					<SubtitleStylePanel
						onClose={() => {
							setPanel(null)
						}}
					/>
				) : panel === "delay" ? (
					<SubtitleDelayPanel
						delay={delay}
						onChange={changeDelay}
						onClose={() => {
							setPanel(null)
						}}
					/>
				) : panel === "cast" ? (
					<StagePanel
						title={t("playerCast")}
						onClose={() => {
							setPanel(null)
						}}
					>
						<p className="text-muted-foreground">{t("playerCastUnavailable")}</p>
					</StagePanel>
				) : null
			}
			holdControls={card !== null || panel !== null || snap.autoplayBlocked}
			onAction={handleAction}
			onControlsVisibleChange={setControlsVisible}
			onInteraction={() => {
				counter.note("interaction")
			}}
		/>
	)
}

function FailureCard({ title, body, onBack, onRetry }: { title: string; body?: string; onBack: () => void; onRetry?: () => void }) {
	const { t } = useTranslation("videos")

	return (
		<StageCenterCard
			title={title}
			onEscape={onBack}
			actions={
				<>
					<Button
						variant={onRetry === undefined ? "default" : "outline"}
						data-primary={onRetry === undefined ? "" : undefined}
						onClick={onBack}
					>
						{t("playerBack")}
					</Button>
					{onRetry === undefined ? null : (
						<Button
							data-primary=""
							onClick={onRetry}
						>
							{t("playerRetry")}
						</Button>
					)}
				</>
			}
		>
			{body === undefined ? null : <p className="text-sm text-muted-foreground">{body}</p>}
		</StageCenterCard>
	)
}
