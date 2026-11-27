import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { Link, useNavigate } from "@tanstack/react-router"
import { toast } from "sonner"
import { CheckIcon, ChevronRightIcon, MoreHorizontalIcon, PlayIcon } from "lucide-react"
import { useQuery } from "@tanstack/react-query"
import type { TFunction } from "i18next"
import { cn } from "@filen/shared"
import { selectSeriesPrimaryAction, type HomeEntry } from "@filen/shared/videos"
import { log } from "@/lib/log"
import { noDiskPersister } from "@/queries/persist"
import { useVideoArt } from "@/features/videos/hooks/useVideoArt"
import { useTitleWatch } from "@/features/videos/hooks/useTitleWatch"
import { watchState } from "@/features/videos/lib/watchState"
import { probeRecords } from "@/features/videos/lib/records"
import { CardObserver, visibleCardObserver } from "@/features/videos/lib/cardObserver"
import {
	defaultSeason,
	countedSeasons,
	episodeWatch,
	seasonKeys,
	seasonLayout,
	seasonProgress,
	seriesButton,
	durationText,
	timeLeftText,
	versionKeys,
	type DetailHeaderMode,
	type SeriesButton
} from "@/features/videos/lib/titleDetail.logic"
import { episodeSubject, titleSubject, type CorrectionSubject } from "@/features/videos/lib/corrections.logic"
import { useLastSeasonQuery, useNfoQuery, rememberSeason } from "@/features/videos/queries/detail"
import { useIsNarrowViewport } from "@/features/shell/hooks/useIsNarrowViewport"
import { DetailHeader } from "@/features/videos/components/detail/detailHeader"
import { EpisodeRows } from "@/features/videos/components/detail/episodeRows"
import { TitleMenu } from "@/features/videos/components/detail/titleMenu"
import { ArtImage } from "@/features/videos/components/videoCard"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { LazyTooltip } from "@/components/lazyTooltip"
import { Separator } from "@/components/ui/separator"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { VideoEpisodeView, VideoSeasonView, VideoTitleDetail } from "@/workers/videoIndex/view.logic"

// The series page: header with the smart primary button from Next Up, season tabs (a select past six seasons
// or on a phone) with each season's unwatched count or a check, and the vertical episode list: a 16:9 still, the
// code and title, runtime, the NFO's synopsis, progress and a check, and a separate Play button. Specials come last,
// collapsed and unmounted. Stills, synopses and runtimes are read only for rows on screen.

type SeriesDetailData = Extract<VideoTitleDetail, { kind: "series" }>

function useWatchToast() {
	const { t } = useTranslation("videos")

	return (work: Promise<void>): void => {
		work.catch((e: unknown) => {
			log.warn("videos.detail", "watch-state change failed", e)
			toast.error(t("videosCardWatchStateFailed"))
		})
	}
}

// The runtime the stored probe knows (a kv read; nothing is probed for a row).
function useStoredRuntime(uuid: string | null, enabled: boolean): number | null {
	const { data } = useQuery({
		queryKey: ["videos", "storedRuntime", uuid ?? ""] as const,
		queryFn: async () => (uuid === null ? null : ((await probeRecords.get(uuid))?.probe?.durationSec ?? null)),
		enabled: enabled && uuid !== null,
		staleTime: 0,
		persister: noDiskPersister
	})

	return data ?? null
}

// The row takes its watch state as plain values, so a change elsewhere in the series leaves it alone.
function EpisodeRow({
	seriesId,
	seriesTitle,
	episode,
	played,
	progress,
	remainingSec,
	play,
	observer,
	onEdit
}: {
	seriesId: string
	seriesTitle: string
	episode: VideoEpisodeView
	played: boolean
	progress: number | null
	remainingSec: number | null
	// The version Play opens.
	play: string | null
	observer: CardObserver | null
	onEdit: (subject: CorrectionSubject) => void
}) {
	const { t } = useTranslation("videos")
	const navigate = useNavigate()
	const report = useWatchToast()
	const [element, setElement] = useState<HTMLDivElement | null>(null)
	const [stillElement, setStillElement] = useState<HTMLDivElement | null>(null)
	const [near, setNear] = useState(false)
	const [seen, setSeen] = useState(false)
	const part = episode.versions[0]?.parts[0] ?? null
	const keys = versionKeys(episode.versions)

	useEffect(() => {
		if (element === null || observer === null) {
			return
		}

		return observer.observe(element, setNear)
	}, [element, observer])

	// The synopsis is a download: only once the row has been on screen.
	useEffect(() => {
		if (element === null || seen) {
			return
		}

		return visibleCardObserver().observe(element, inView => {
			if (inView) {
				setSeen(true)
			}
		})
	}, [element, seen])

	const art = useVideoArt({
		titleId: seriesId,
		stableUuid: part?.file.stableUuid ?? null,
		slot: "s",
		title: seriesTitle,
		near,
		element: stillElement
	})
	const nfo = useNfoQuery(part?.nfo ?? null, seen).data ?? null
	const storedRuntime = useStoredRuntime(part?.file.uuid ?? null, near)
	const runtime = storedRuntime ?? (nfo?.runtimeMinutes === undefined ? null : nfo.runtimeMinutes * 60)
	const code =
		episode.episode > 0
			? episode.episodeEnd > episode.episode
				? `E${String(episode.episode)}-E${String(episode.episodeEnd)}`
				: `E${String(episode.episode)}`
			: ""
	const heading = code.length === 0 ? episode.title : episode.title.length === 0 ? code : `${code} · ${episode.title}`
	const label = heading.length > 0 ? heading : seriesTitle
	const unsupported = part?.unsupported === true
	const remaining = remainingSec === null ? null : timeLeftText(remainingSec, t)

	return (
		<div
			ref={setElement}
			className="group/episode flex items-start gap-3 py-3 md:gap-4"
		>
			<div
				ref={setStillElement}
				className={cn(
					"relative aspect-video w-28 shrink-0 overflow-hidden rounded-xl bg-muted/40 md:w-40",
					unsupported && "opacity-60"
				)}
			>
				{art.kind === "image" ? (
					<ArtImage
						key={art.url}
						url={art.url}
						fit={art.fit}
					/>
				) : null}
				{progress === null ? null : (
					<div
						aria-hidden="true"
						className="absolute inset-x-0 bottom-0 h-[3px] bg-foreground/15"
					>
						<div
							className="h-full bg-primary"
							style={{ width: `${String(Math.max(2, progress * 100))}%` }}
						/>
					</div>
				)}
				{play === null || unsupported ? null : (
					// On a phone the row has no room beside the text: Play sits on the still.
					<button
						type="button"
						tabIndex={-1}
						aria-label={t("videosCardPlayLabel", { title: label })}
						className="absolute inset-0 m-auto flex size-9 items-center justify-center rounded-full bg-black/60 text-white md:hidden"
						onClick={() => {
							void navigate({ to: "/videos/watch/$uuid", params: { uuid: seriesId }, search: { file: play } })
						}}
					>
						<PlayIcon className="size-4 fill-current" />
					</button>
				)}
			</div>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex items-baseline gap-3">
					{play === null || unsupported ? (
						<span className="min-w-0 flex-1 truncate text-sm font-medium">{label}</span>
					) : (
						<Link
							to="/videos/watch/$uuid"
							params={{ uuid: seriesId }}
							search={{ file: play }}
							className="min-w-0 flex-1 truncate rounded-md text-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
						>
							{label}
						</Link>
					)}
					{runtime === null ? null : (
						<span className="shrink-0 text-xs text-muted-foreground tabular-nums">{durationText(runtime, t)}</span>
					)}
					{played ? (
						<span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground/10">
							<CheckIcon
								className="size-3"
								aria-hidden="true"
							/>
							<span className="sr-only">{t("videosCardWatched")}</span>
						</span>
					) : null}
				</div>
				{nfo?.plot === undefined ? null : <p className="line-clamp-2 text-sm text-muted-foreground md:line-clamp-3">{nfo.plot}</p>}
				{progress === null || remaining === null ? null : (
					<div
						role="progressbar"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={Math.round(progress * 100)}
						aria-valuetext={remaining}
						className="flex max-w-xs items-center gap-3"
					>
						<div className="h-1 flex-1 overflow-hidden rounded-full bg-foreground/15">
							<div
								className="h-full bg-primary"
								style={{ width: `${String(Math.max(2, progress * 100))}%` }}
							/>
						</div>
						<span className="text-xs text-muted-foreground tabular-nums">{remaining}</span>
					</div>
				)}
			</div>
			<div className="-mr-2 flex shrink-0 items-center gap-1 md:mr-0">
				{play === null || unsupported ? null : (
					<LazyTooltip
						label={t("videosCardPlayLabel", { title: label })}
						className="hidden md:inline-flex"
					>
						<Button
							variant="ghost"
							size="icon"
							tabIndex={-1}
							className="hidden md:inline-flex"
							aria-label={t("videosCardPlayLabel", { title: label })}
							onClick={() => {
								void navigate({ to: "/videos/watch/$uuid", params: { uuid: seriesId }, search: { file: play } })
							}}
						>
							<PlayIcon className="fill-current" />
						</Button>
					</LazyTooltip>
				)}
				<DropdownMenu>
					<Tooltip>
						<TooltipTrigger
							render={
								<DropdownMenuTrigger
									render={
										<Button
											variant="ghost"
											size="icon"
											aria-label={t("detailEpisodeMenu", { title: label })}
										>
											<MoreHorizontalIcon />
										</Button>
									}
								/>
							}
						/>
						<TooltipContent>{t("detailEpisodeMenu", { title: label })}</TooltipContent>
					</Tooltip>
					<DropdownMenuContent align="end">
						{unsupported ? null : played ? (
							<DropdownMenuItem
								onClick={() => {
									report(watchState.markUnwatched({ stableUuids: keys }))
								}}
							>
								{t("videosCardMarkUnwatched")}
							</DropdownMenuItem>
						) : (
							<DropdownMenuItem
								onClick={() => {
									report(watchState.markWatched({ stableUuids: keys }))
								}}
							>
								<CheckIcon />
								{t("videosCardMarkWatched")}
							</DropdownMenuItem>
						)}
						<DropdownMenuItem
							onClick={() => {
								const subject = episodeSubject(seriesId, episode)

								if (subject !== null) {
									onEdit(subject)
								}
							}}
						>
							{t("detailEditEpisode")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		</div>
	)
}

function EpisodeList({
	detail,
	season,
	entries,
	observer,
	onEdit
}: {
	detail: SeriesDetailData
	season: VideoSeasonView
	entries: ReadonlyMap<string, HomeEntry>
	observer: CardObserver | null
	onEdit: (subject: CorrectionSubject) => void
}) {
	const episodes = season.episodes

	function rowKey(index: number): string {
		return episodes[index]?.versions[0]?.parts[0]?.file.stableUuid ?? `${String(season.number)}:${String(index)}`
	}

	return (
		<EpisodeRows
			count={episodes.length}
			rowKey={rowKey}
			renderRow={index => {
				const episode = episodes[index]

				if (episode === undefined) {
					return null
				}

				const watch = episodeWatch(episode.versions, entries)

				return (
					<EpisodeRow
						seriesId={detail.title.id}
						seriesTitle={detail.title.title}
						episode={episode}
						played={watch.played}
						progress={watch.progress}
						remainingSec={watch.remainingSec}
						play={watch.stableUuid}
						observer={observer}
						onEdit={onEdit}
					/>
				)
			}}
		/>
	)
}

function SeasonLabel({ number, unwatched, watched }: { number: number; unwatched: number; watched: boolean }) {
	const { t } = useTranslation("videos")

	return (
		<>
			{t("playerSeason", { number })}
			{watched ? (
				<>
					<CheckIcon
						aria-hidden="true"
						className="size-3.5"
					/>
					<span className="sr-only">{t("videosCardWatched")}</span>
				</>
			) : unwatched > 0 ? (
				<span className="text-xs text-muted-foreground tabular-nums">
					<span aria-hidden="true">({unwatched})</span>
					<span className="sr-only">{t("videosCardUnwatchedCount", { count: unwatched })}</span>
				</span>
			) : null}
		</>
	)
}

function buttonLabel(button: SeriesButton, t: TFunction<"videos">): string {
	switch (button.kind) {
		case "resume":
			return t("detailResumeEpisode", {
				code: `S${String(button.season)}E${String(button.episode)}`,
				left: timeLeftText(button.remainingSec, t)
			})
		case "next":
			return t("detailPlayEpisode", { code: `S${String(button.season)}E${String(button.episode)}` })
		case "play":
			return t("videosHomePlay")
	}
}

export function SeriesDetail({
	detail,
	headerMode,
	onBack,
	onEdit
}: {
	detail: SeriesDetailData
	headerMode: DetailHeaderMode
	onBack: () => void
	onEdit: (subject: CorrectionSubject) => void
}) {
	const { t } = useTranslation("videos")
	const navigate = useNavigate()
	const report = useWatchToast()
	const headingId = useId()
	const panelId = useId()
	const specialsId = useId()
	const narrow = useIsNarrowViewport()
	const { index, entries } = useTitleWatch(detail)
	const title = detail.title
	const layout = seasonLayout(detail.seasons)
	const action = selectSeriesPrimaryAction({ index, seriesId: title.id })
	const button = seriesButton(action)
	const lastSeason = useLastSeasonQuery(title.id)
	const [picked, setPicked] = useState<number | null>(null)
	const [specialsOpen, setSpecialsOpen] = useState(false)
	const [listElement, setListElement] = useState<HTMLDivElement | null>(null)
	const tabRefs = useRef(new Map<number, HTMLButtonElement>())
	const regularNumbers = layout.regular.map(season => season.number)
	const current =
		picked !== null && regularNumbers.includes(picked)
			? picked
			: defaultSeason({ regular: regularNumbers, action, lastViewed: lastSeason.data ?? null })
	// The season last viewed is a local read: the list waits for it rather than jump from another season.
	const season = lastSeason.isPending ? null : (layout.regular.find(item => item.number === current) ?? null)
	// A season switch mounts the new season's rows: rendered in the background, so the tabs answer at once however
	// long the season is. On mount it renders at once; a restored scroll position follows the rows as they mount.
	const listSeason = useDeferredValue(season)
	const allKeys = detail.seasons.flatMap(item => seasonKeys(item))
	// The numbered seasons, or the specials when that is all there is.
	const counted = countedSeasons(layout)
	const countedKeys = counted.flatMap(item => seasonKeys(item))
	const unwatched = counted.reduce((sum, item) => sum + seasonProgress(item, entries).unwatched, 0)
	const allWatched = countedKeys.length > 0 && unwatched === 0
	const episodeCount = counted.reduce((sum, item) => sum + item.episodes.length, 0)
	// Rows within half a screen of the visible part may read stored art and runtimes.
	const observer = useMemo(
		() => (listElement === null ? null : new CardObserver({ root: null, rootMargin: "50% 0px", threshold: 0 })),
		[listElement]
	)

	useEffect(() => {
		return () => {
			observer?.disconnect()
		}
	}, [observer])

	function pick(number: number): void {
		setPicked(number)
		rememberSeason(title.id, number)
	}

	function onTabKey(event: KeyboardEvent<HTMLDivElement>): void {
		const at = current === null ? -1 : regularNumbers.indexOf(current)
		let next: number

		switch (event.key) {
			case "ArrowRight":
				next = (at + 1) % regularNumbers.length
				break
			case "ArrowLeft":
				next = (at - 1 + regularNumbers.length) % regularNumbers.length
				break
			case "Home":
				next = 0
				break
			case "End":
				next = regularNumbers.length - 1
				break
			default:
				return
		}

		const number = regularNumbers[next]

		if (number !== undefined) {
			event.preventDefault()
			pick(number)
			tabRefs.current.get(number)?.focus()
		}
	}

	const meta: string[] = []

	if (title.year > 0) {
		meta.push(String(title.year))
	}

	if (layout.regular.length > 0) {
		meta.push(t("detailSeasonCount", { count: layout.regular.length }))
	}

	meta.push(t("detailEpisodeCount", { count: episodeCount }))

	if (unwatched > 0 && unwatched < episodeCount) {
		meta.push(t("detailUnwatchedCount", { count: unwatched }))
	}

	const selector = narrow && layout.selector === "tabs" ? "select" : layout.selector
	const seasonOptions = layout.regular.map(item => {
		const progress = seasonProgress(item, entries)

		return {
			value: String(item.number),
			label: progress.watched
				? t("detailSeasonWatched", { number: item.number })
				: progress.unwatched > 0
					? t("detailSeasonUnwatched", { number: item.number, count: progress.unwatched })
					: t("playerSeason", { number: item.number })
		}
	})
	const seasonWatched = season === null ? false : seasonProgress(season, entries).watched

	return (
		<>
			<DetailHeader
				mode={headerMode}
				titleId={title.id}
				title={title.title}
				headingId={headingId}
				eyebrow={t("detailEyebrowSeries")}
				onBack={onBack}
				menu={
					<TitleMenu
						title={title}
						overrideKey={titleSubject(detail).key}
						fileStableUuid={null}
						versions={null}
						version=""
						onVersion={() => undefined}
						onEdit={() => {
							onEdit(titleSubject(detail))
						}}
					/>
				}
				meta={<p className="min-h-5 text-sm text-muted-foreground tabular-nums">{meta.join(" · ")}</p>}
				actions={
					<div className="flex flex-wrap items-center gap-2">
						{button === null ? null : (
							<Button
								onClick={() => {
									void navigate({
										to: "/videos/watch/$uuid",
										params: { uuid: title.id },
										search: { file: button.stableUuid }
									})
								}}
							>
								<PlayIcon
									data-icon="inline-start"
									className="fill-current"
								/>
								{buttonLabel(button, t)}
							</Button>
						)}
						{allKeys.length === 0 ? null : (
							<Button
								variant="outline"
								onClick={() => {
									report(
										allWatched
											? watchState.markUnwatched({ stableUuids: allKeys })
											: watchState.markWatched({ stableUuids: allKeys })
									)
								}}
							>
								<CheckIcon data-icon="inline-start" />
								{allWatched ? t("detailMarkSeriesUnwatched") : t("detailMarkSeriesWatched")}
							</Button>
						)}
					</div>
				}
			/>
			<div
				ref={setListElement}
				className="flex flex-col gap-4 px-4 pb-10 md:px-6"
			>
				{season === null ? null : (
					<div className="flex min-h-8 items-center gap-2">
						{selector === "tabs" ? (
							<div
								role="tablist"
								aria-label={t("detailSeasons")}
								className="-mx-1 flex min-w-0 flex-1 gap-1 overflow-x-auto px-1 py-0.5"
								onKeyDown={onTabKey}
							>
								{layout.regular.map(item => {
									const progress = seasonProgress(item, entries)
									const selected = item.number === current

									return (
										<Button
											key={item.number}
											ref={(node: HTMLButtonElement | null) => {
												if (node === null) {
													tabRefs.current.delete(item.number)
												} else {
													tabRefs.current.set(item.number, node)
												}
											}}
											role="tab"
											aria-selected={selected}
											aria-controls={panelId}
											tabIndex={selected ? 0 : -1}
											variant={selected ? "secondary" : "ghost"}
											size="sm"
											className="rounded-full"
											onClick={() => {
												pick(item.number)
											}}
										>
											<SeasonLabel
												number={item.number}
												unwatched={progress.unwatched}
												watched={progress.watched}
											/>
										</Button>
									)
								})}
							</div>
						) : selector === "select" ? (
							<div className="min-w-0 flex-1">
								<Select
									items={seasonOptions}
									value={String(season.number)}
									onValueChange={value => {
										if (value !== null) {
											pick(Number(value))
										}
									}}
								>
									<SelectTrigger
										size="sm"
										aria-label={t("detailSeasons")}
										className="min-w-44"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectGroup>
											{seasonOptions.map(option => (
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
						) : (
							<p className="min-w-0 flex-1 text-sm font-medium">{t("playerSeason", { number: season.number })}</p>
						)}
						<DropdownMenu>
							<Tooltip>
								<TooltipTrigger
									render={
										<DropdownMenuTrigger
											render={
												<Button
													variant="ghost"
													size="icon"
													aria-label={t("detailSeasonMenu", { number: season.number })}
												>
													<MoreHorizontalIcon />
												</Button>
											}
										/>
									}
								/>
								<TooltipContent>{t("detailSeasonMenu", { number: season.number })}</TooltipContent>
							</Tooltip>
							<DropdownMenuContent align="end">
								<DropdownMenuItem
									onClick={() => {
										const keys = seasonKeys(season)

										report(
											seasonWatched
												? watchState.markUnwatched({ stableUuids: keys })
												: watchState.markWatched({ stableUuids: keys })
										)
									}}
								>
									{seasonWatched ? null : <CheckIcon />}
									{seasonWatched ? t("detailMarkSeasonUnwatched") : t("detailMarkSeasonWatched")}
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
				)}
				<Separator />
				{listSeason === null ? null : (
					<div
						id={panelId}
						role={selector === "tabs" ? "tabpanel" : undefined}
						aria-label={t("playerSeason", { number: listSeason.number })}
					>
						<EpisodeList
							key={listSeason.number}
							detail={detail}
							season={listSeason}
							entries={entries}
							observer={observer}
							onEdit={onEdit}
						/>
					</div>
				)}
				{layout.specials === null || lastSeason.isPending ? null : season === null ? (
					<EpisodeList
						detail={detail}
						season={layout.specials}
						entries={entries}
						observer={observer}
						onEdit={onEdit}
					/>
				) : (
					<section className="flex flex-col">
						<Button
							variant="ghost"
							className="self-start"
							aria-expanded={specialsOpen}
							aria-controls={specialsId}
							onClick={() => {
								setSpecialsOpen(!specialsOpen)
							}}
						>
							<ChevronRightIcon
								data-icon="inline-start"
								className={cn("transition-transform motion-reduce:transition-none", specialsOpen && "rotate-90")}
							/>
							{t("detailSpecials", { count: layout.specials.episodes.length })}
						</Button>
						<div id={specialsId}>
							{specialsOpen ? (
								<EpisodeList
									detail={detail}
									season={layout.specials}
									entries={entries}
									observer={observer}
									onEdit={onEdit}
								/>
							) : null}
						</div>
					</section>
				)}
			</div>
		</>
	)
}
