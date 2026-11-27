import { useEffect, useRef, useState } from "react"
import { Trash2, X, AlertCircle } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useVirtualizer } from "@tanstack/react-virtual"
import { audioEngine } from "@/features/audio/lib/audioEngine"
import { clearQueueWithUndo } from "@/features/audio/lib/queueActions"
import { useAudioStore, useAudioQueue } from "@/features/audio/store/useAudioStore"
import { useTrackTagsStore } from "@/features/audio/store/useTrackTagsStore"
import { trackDisplayTitle } from "@/features/audio/lib/trackTags.logic"
import type { QueueTrack } from "@/features/audio/store/audioQueue"
import { ShuffleToggleButton, LoopToggleButton, NOW_PLAYING_CONTROL_CLASS } from "@/features/audio/components/queueToggles"
import { SmoothTransitionsToggleButton } from "@/features/audio/components/smoothTransitionsToggle"
import { Button } from "@/components/ui/button"
import { TooltipIconButton } from "@/components/ui/tooltipIconButton"
import { LazyTooltip } from "@/components/lazyTooltip"
import { Spinner } from "@/components/ui/spinner"
import { useCoarsePointer } from "@/features/office/components/ribbon/phoneMedia"
import { observeElementOffsetFromAttach } from "@/lib/virtualScroll"
import { cn } from "@filen/shared"

// Row heights pinned on the row itself (h-8, and h-11 where the remove button grows to a touch target), so the
// virtualizer needs no measuring pass.
const ROW_HEIGHT = 32
const COARSE_ROW_HEIGHT = 44
const ROW_OVERSCAN = 8
// Rows to render before the list has been measured (the popover's first pass, and jsdom): its max height.
const INITIAL_VIEWPORT_HEIGHT = 448

// The now-playing panel body (rendered inside the player bar's queue popover): the live queue (current
// track highlighted, click-to-jump, per-row remove, clear-queue, shuffle/loop toggles) — queue only.
// Playlists moved to their own rail-routed split view (features/audio/screens/playlists.tsx plus the
// shell's PlaylistsSidebar) so they're reachable without a playing queue first; this popover no
// longer carries a tab bar at all. Reads the queue reactively; every queue mutation goes straight to the
// engine singleton, which drives the store.
export function NowPlayingPanel() {
	const { t } = useTranslation("audio")
	const { queue, currentIndex, coverUrlsByUuid } = useAudioQueue()
	const status = useAudioStore(state => state.status)
	// The track the last failure is about, which an auto-skip has already moved past.
	const failedUuid = useAudioStore(state => state.lastErrorTrack?.uuid)
	const removeLabel = t("removeFromQueue")

	return (
		<div className="flex max-h-[min(60vh,28rem)] flex-col overflow-hidden">
			<div className="flex items-center justify-between gap-2 px-1 pb-2">
				<div className="min-w-0">
					<p className="text-xs text-muted-foreground">{t("queueCount", { count: queue.length })}</p>
				</div>
				<div className="flex items-center gap-1">
					<ShuffleToggleButton className={NOW_PLAYING_CONTROL_CLASS} />
					<LoopToggleButton className={NOW_PLAYING_CONTROL_CLASS} />
					<SmoothTransitionsToggleButton className={NOW_PLAYING_CONTROL_CLASS} />
					<TooltipIconButton
						label={t("clearQueue")}
						className={NOW_PLAYING_CONTROL_CLASS}
						onClick={clearQueueWithUndo}
					>
						<Trash2 />
					</TooltipIconButton>
				</div>
			</div>
			<QueueList
				queue={queue}
				currentIndex={currentIndex}
				loading={status === "loading"}
				failedUuid={failedUuid}
				coverUrlsByUuid={coverUrlsByUuid}
				removeLabel={removeLabel}
			/>
		</div>
	)
}

// A queue can hold a whole directory, so only the rows in view mount (and subscribe to the tags store).
function QueueList({
	queue,
	currentIndex,
	loading,
	failedUuid,
	coverUrlsByUuid,
	removeLabel
}: {
	queue: readonly QueueTrack[]
	currentIndex: number
	loading: boolean
	failedUuid: string | undefined
	coverUrlsByUuid: Readonly<Record<string, string>>
	removeLabel: string
}) {
	// Kept out of the React Compiler: the virtualizer is one mutable instance, so row JSX memoized on it
	// would go stale on scroll. QueueRow and QueueTrackTitle still compile.
	"use no memo"

	const listRef = useRef<HTMLUListElement>(null)
	const coarse = useCoarsePointer()
	const rowHeight = coarse ? COARSE_ROW_HEIGHT : ROW_HEIGHT
	// The track playing when the popover opened (the panel mounts on open): scrolled to once, not on every
	// track change, so a reader scrolling the queue is left where they are.
	const [openIndex] = useState(currentIndex)
	const virtualizer = useVirtualizer({
		count: queue.length,
		getScrollElement: () => listRef.current,
		observeElementOffset: observeElementOffsetFromAttach,
		estimateSize: () => rowHeight,
		overscan: ROW_OVERSCAN,
		initialRect: { width: 0, height: INITIAL_VIEWPORT_HEIGHT }
	})
	const virtualRows = virtualizer.getVirtualItems()
	const firstRow = virtualRows.at(0)
	const lastRow = virtualRows.at(-1)

	// After mount: the popover has no size on its first pass, so this runs once the list is attached.
	useEffect(() => {
		if (openIndex < virtualizer.options.count) {
			virtualizer.scrollToIndex(openIndex, { align: "center" })
		}
	}, [openIndex, virtualizer])

	// The pointer type can change under a hybrid device: re-lay the rows at the new height.
	useEffect(() => {
		virtualizer.measure()
	}, [rowHeight, virtualizer])

	return (
		<ul
			ref={listRef}
			className="-mx-1 min-h-0 scrollbar-gutter-stable overflow-y-auto"
			style={{
				paddingTop: firstRow?.start ?? 0,
				paddingBottom: lastRow !== undefined ? virtualizer.getTotalSize() - lastRow.end : 0
			}}
		>
			{virtualRows.map(virtualRow => {
				const queueTrack = queue[virtualRow.index]

				if (!queueTrack) {
					return null
				}

				const current = virtualRow.index === currentIndex

				return (
					<QueueRow
						key={queueTrack.uuid}
						track={queueTrack}
						index={virtualRow.index}
						current={current}
						loading={current && loading}
						failed={queueTrack.uuid === failedUuid}
						coverUrl={coverUrlsByUuid[queueTrack.uuid]}
						removeLabel={removeLabel}
					/>
				)
			})}
		</ul>
	)
}

// Its own component with primitive props so a track change or cover mint re-renders only the mounted rows
// whose props changed, not every row in view.
function QueueRow({
	track,
	index,
	current,
	loading,
	failed,
	coverUrl,
	removeLabel
}: {
	track: QueueTrack
	index: number
	current: boolean
	loading: boolean
	failed: boolean
	coverUrl: string | undefined
	removeLabel: string
}) {
	return (
		<li className={cn("group/qrow flex h-8 items-center gap-2 rounded-lg px-1 pr-1.5 pointer-coarse:h-11", current && "bg-muted")}>
			<button
				type="button"
				aria-current={current ? "true" : undefined}
				className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left focus-ring-row outline-none"
				onClick={() => {
					void audioEngine.playIndex(index)
				}}
			>
				{/* Leading slot: the current row shows loading/error state; any row with a cached cover
				    shows a thumb (cached-only — never triggers a fetch); everything else is the plain
				    track number. */}
				{loading ? (
					<Spinner className="size-4 shrink-0 text-primary" />
				) : failed ? (
					<AlertCircle className="size-4 shrink-0 text-destructive" />
				) : coverUrl ? (
					<img
						src={coverUrl}
						alt=""
						className="size-5 shrink-0 rounded object-cover thumbnail-range"
					/>
				) : (
					<span
						className={cn("w-5 shrink-0 text-right text-xs tabular-nums", current ? "text-primary" : "text-muted-foreground")}
					>
						{index + 1}
					</span>
				)}
				<QueueTrackTitle
					track={track}
					current={current}
				/>
			</button>
			<LazyTooltip
				label={removeLabel}
				className="inline-flex shrink-0"
			>
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label={removeLabel}
					className={cn(
						"shrink-0 opacity-0 transition-opacity group-hover/qrow:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 pointer-coarse:[&_svg:not([class*='size-'])]:size-4",
						NOW_PLAYING_CONTROL_CLASS
					)}
					onClick={() => {
						void audioEngine.removeAt(index)
					}}
				>
					<X />
				</Button>
			</LazyTooltip>
		</li>
	)
}

// Its own component so a track's tags landing re-renders that one row, and only mounted rows subscribe.
// Reads only tags already known: a read on mount would read every row scrolled past.
function QueueTrackTitle({ track, current }: { track: QueueTrack; current: boolean }) {
	const record = useTrackTagsStore(state => state.byUuid[track.uuid])
	const title = trackDisplayTitle(record, track.name)

	return (
		<span
			title={title}
			className={cn("min-w-0 flex-1 truncate text-sm", current && "font-medium text-primary")}
		>
			{title}
		</span>
	)
}
