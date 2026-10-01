import { Trash2, X, AlertCircle } from "lucide-react"
import { useTranslation } from "react-i18next"
import { audioEngine } from "@/features/audio/lib/audioEngine"
import { useAudioStore, useAudioQueue } from "@/features/audio/store/useAudioStore"
import { useTrackTagsStore } from "@/features/audio/store/useTrackTagsStore"
import { trackDisplayTitle } from "@/features/audio/lib/trackTags.logic"
import type { QueueTrack } from "@/features/audio/store/audioQueue"
import { ShuffleToggleButton, LoopToggleButton } from "@/features/audio/components/queueToggles"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@filen/shared"

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
					<ShuffleToggleButton />
					<LoopToggleButton />
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={t("clearQueue")}
						onClick={() => {
							audioEngine.clearQueue()
						}}
					>
						<Trash2 />
					</Button>
				</div>
			</div>
			<ul className="-mx-1 flex min-h-0 flex-col overflow-y-auto">
				{queue.map((queueTrack, index) => (
					<QueueRow
						key={queueTrack.uuid}
						track={queueTrack}
						index={index}
						current={index === currentIndex}
						loading={index === currentIndex && status === "loading"}
						failed={queueTrack.uuid === failedUuid}
						coverUrl={coverUrlsByUuid[queueTrack.uuid]}
						removeLabel={removeLabel}
					/>
				))}
			</ul>
		</div>
	)
}

// Its own component with primitive props so a track change or cover mint re-renders only the rows
// whose props changed, not every row of an unvirtualized queue.
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
		<li className={cn("group/qrow flex items-center gap-2 rounded-lg px-1 pr-1.5", current && "bg-muted")}>
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
						className="size-5 shrink-0 rounded object-cover"
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
			<Button
				variant="ghost"
				size="icon-xs"
				aria-label={removeLabel}
				className="shrink-0 opacity-0 transition-opacity group-hover/qrow:opacity-100 focus-visible:opacity-100"
				onClick={() => {
					void audioEngine.removeAt(index)
				}}
			>
				<X />
			</Button>
		</li>
	)
}

// Its own component so a track's tags landing re-renders that one row. Reads only tags already known:
// the queue is not virtualized, so reading on mount here would read the whole queue.
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
