import { useEffect, useRef, useState, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { CheckIcon, XIcon } from "lucide-react"
import { deriveWatchState, itemKey, type ItemRec, type WatchStateDoc } from "@filen/shared/videos"
import { cn } from "@filen/shared"
import { Button } from "@/components/ui/button"
import { MediaTooltip } from "@/components/media/video/stageButton"
import { STAGE_POPUP_TONE_CLASS, useRestoreStageFocus } from "@/components/media/video/stageContext"
import { episodeCode, type WatchItemTarget } from "@/features/videos/lib/player/watchTarget.logic"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"

// The episodes side sheet: seasons as toggle buttons, the season's episodes as a virtualized list with progress,
// all from the local index and the watch state already in memory. Picking one plays it on the same element. Only
// EpisodeRows holds the virtualizer (the React Compiler skips a component that does): the panel and each row compile.

const ROW_HEIGHT = 56

export function EpisodesPanel({
	episodes,
	currentKey,
	doc,
	onPick,
	onClose
}: {
	episodes: readonly WatchItemTarget[]
	currentKey: string
	doc: WatchStateDoc
	onPick: (target: WatchItemTarget) => void
	onClose: () => void
}) {
	const { t } = useTranslation(["videos", "common"])
	const current = episodes.find(episode => episode.key === currentKey)
	const seasons = [...new Set(episodes.map(episode => episode.episode?.season ?? 1))]
	const [season, setSeason] = useState(current?.episode?.season ?? seasons[0] ?? 1)
	const rows = episodes.filter(episode => (episode.episode?.season ?? 1) === season)
	const panelRef = useRef<HTMLDivElement>(null)

	useRestoreStageFocus()

	return (
		<div
			ref={panelRef}
			role="dialog"
			aria-label={t("playerEpisodes")}
			className={cn(
				"absolute inset-y-0 right-0 z-10 flex w-[min(24rem,100%)] flex-col gap-2 rounded-l-3xl py-4 pr-[max(0.75rem,env(safe-area-inset-right))] pl-3",
				STAGE_POPUP_TONE_CLASS
			)}
			onKeyDown={event => {
				if (event.key === "Escape") {
					event.preventDefault()
					event.stopPropagation()
					onClose()
				} else if (event.key !== "Tab") {
					event.stopPropagation()
				}
			}}
		>
			<div className="flex items-center justify-between px-1">
				<h2 className="text-base font-semibold">{t("playerEpisodes")}</h2>
				<MediaTooltip label={t("common:close")}>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={t("common:close")}
						onClick={onClose}
					>
						<XIcon />
					</Button>
				</MediaTooltip>
			</div>
			{seasons.length > 1 ? (
				<div
					role="group"
					aria-label={t("detailSeasons")}
					className="flex gap-1 overflow-x-auto px-1 pb-1"
				>
					{seasons.map(number => (
						<Button
							key={number}
							aria-pressed={number === season}
							variant={number === season ? "secondary" : "ghost"}
							size="xs"
							className="rounded-full"
							onClick={() => {
								setSeason(number)
							}}
						>
							{number === 0 ? t("playerSpecials") : t("playerSeason", { number })}
						</Button>
					))}
				</div>
			) : null}
			<EpisodeRows
				rows={rows}
				season={season}
				currentKey={currentKey}
				doc={doc}
				panelRef={panelRef}
				onPick={onPick}
			/>
		</div>
	)
}

function EpisodeRows({
	rows,
	season,
	currentKey,
	doc,
	panelRef,
	onPick
}: {
	rows: readonly WatchItemTarget[]
	season: number
	currentKey: string
	doc: WatchStateDoc
	panelRef: RefObject<HTMLDivElement | null>
	onPick: (target: WatchItemTarget) => void
}) {
	const scrollRef = useRef<HTMLDivElement>(null)
	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 6,
		observeElementOffset: observeElementOffsetFromAttach
	})
	const currentIndex = rows.findIndex(episode => episode.key === currentKey)

	// A season without the playing episode starts at its top, not at the previous season's offset.
	useEffect(() => {
		if (currentIndex >= 0) {
			virtualizer.scrollToIndex(currentIndex, { align: "center" })
		} else if (scrollRef.current !== null) {
			scrollRef.current.scrollTop = 0
		}

		panelRef.current?.querySelector<HTMLElement>("[aria-current='true'], [aria-pressed='true']")?.focus({ preventScroll: true })
	}, [season, currentIndex, virtualizer, panelRef])

	return (
		<div
			ref={scrollRef}
			className="min-h-0 flex-1 scrollbar-gutter-stable overflow-y-auto"
		>
			<ul
				className="relative w-full"
				style={{ height: virtualizer.getTotalSize() }}
			>
				{virtualizer.getVirtualItems().map(row => {
					const episode = rows[row.index]

					return episode === undefined ? null : (
						<EpisodeRow
							key={episode.key}
							episode={episode}
							rec={doc.items[itemKey(episode.key)]}
							playing={episode.key === currentKey}
							top={row.start}
							onPick={onPick}
						/>
					)
				})}
			</ul>
		</div>
	)
}

function EpisodeRow({
	episode,
	rec,
	playing,
	top,
	onPick
}: {
	episode: WatchItemTarget
	rec: ItemRec | undefined
	playing: boolean
	top: number
	onPick: (target: WatchItemTarget) => void
}) {
	const { t } = useTranslation("videos")
	const info = episode.episode

	if (info === null) {
		return null
	}

	const first = episode.parts[0]?.file
	const state = first === undefined ? null : deriveWatchState({ rec, file: { uuid: first.uuid, size: first.size } })
	const progress = state !== null && state.inProgress && state.durationSec > 0 ? state.positionSec / state.durationSec : null

	return (
		<li
			className="absolute inset-x-0"
			style={{ top, height: ROW_HEIGHT }}
		>
			<button
				type="button"
				aria-current={playing}
				className={cn(
					"flex size-full items-center gap-3 rounded-xl px-2 text-left outline-none hover:bg-white/10 focus-visible:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/40",
					playing && "bg-white/10"
				)}
				onClick={() => {
					if (!playing) {
						onPick(episode)
					}
				}}
			>
				<span className="w-14 shrink-0 text-xs text-muted-foreground tabular-nums">{episodeCode(info)}</span>
				<span className="flex min-w-0 flex-1 flex-col gap-1">
					<span className="truncate text-sm">{info.title.length > 0 ? info.title : episodeCode(info)}</span>
					{progress === null ? null : (
						<span className="h-0.5 w-full overflow-hidden rounded-full bg-white/20">
							<span
								className="block h-full origin-left bg-white"
								style={{ transform: `scaleX(${String(progress)})` }}
							/>
						</span>
					)}
				</span>
				{playing ? (
					<span className="shrink-0 text-xs text-muted-foreground">{t("playerEpisodeNow")}</span>
				) : state?.played === true ? (
					<CheckIcon
						aria-label={t("playerEpisodeWatched")}
						className="size-4 shrink-0 text-muted-foreground"
					/>
				) : null}
			</button>
		</li>
	)
}
