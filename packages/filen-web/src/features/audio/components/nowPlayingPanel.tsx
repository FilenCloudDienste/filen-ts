import { useState } from "react"
import { useTranslation } from "react-i18next"
import { Shuffle, Repeat, Repeat1, Trash2, X, ListMusic, AlertCircle } from "lucide-react"
import { audioEngine } from "@/features/audio/lib/audioEngine"
import { useAudioQueue, useAudioQueueControls, useAudioNowPlaying, useAudioError } from "@/features/audio/store/useAudioStore"
import { nextLoopMode } from "@/features/audio/components/audioTransport.logic"
import { PlaylistsPanel } from "@/features/audio/components/playlistsPanel"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

type PanelTab = "queue" | "playlists"

// The now-playing panel body (rendered inside the player bar's queue popover): a two-tab surface — the
// live queue (current track highlighted, click-to-jump, per-row remove, clear-queue, shuffle/loop
// toggles) and Playlists (CRUD over `.filen/Playlists` — see playlistsPanel.tsx). Playlists lives here
// rather than a new shell/rail module: the founder spec keeps it inside the audio feature's existing
// surface, since a whole rail entry for this is more than the feature warrants. Reads the queue
// reactively; every queue mutation goes straight to the engine singleton, which drives the store.
export function NowPlayingPanel() {
	const { t } = useTranslation("audio")
	const { queue, currentIndex, coverUrlsByUuid } = useAudioQueue()
	const { shuffleEnabled, loopMode } = useAudioQueueControls()
	const { status } = useAudioNowPlaying()
	const lastError = useAudioError()
	const [tab, setTab] = useState<PanelTab>("queue")
	const LoopIcon = loopMode === "one" ? Repeat1 : Repeat

	return (
		<div className="flex max-h-[min(60vh,28rem)] flex-col overflow-hidden">
			<div
				role="tablist"
				aria-label={t("nowPlayingTabsLabel")}
				className="mb-2 flex items-center gap-1 rounded-lg bg-muted p-0.5"
			>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "queue"}
					className={cn(
						"flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
						tab === "queue" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
					)}
					onClick={() => {
						setTab("queue")
					}}
				>
					{t("queue")}
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "playlists"}
					className={cn(
						"flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors",
						tab === "playlists" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
					)}
					onClick={() => {
						setTab("playlists")
					}}
				>
					<ListMusic className="size-3.5" />
					{t("playlists")}
				</button>
			</div>
			{tab === "playlists" ? (
				<PlaylistsPanel />
			) : (
				<>
					<div className="flex items-center justify-between gap-2 px-1 pb-2">
						<div className="min-w-0">
							<p className="text-xs text-muted-foreground">{t("queueCount", { count: queue.length })}</p>
						</div>
						<div className="flex items-center gap-1">
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={t("shuffle")}
								aria-pressed={shuffleEnabled}
								className={cn(shuffleEnabled && "text-primary")}
								onClick={() => {
									audioEngine.setShuffleEnabled(!shuffleEnabled)
								}}
							>
								<Shuffle />
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={loopMode === "off" ? t("loopOff") : loopMode === "all" ? t("loopAll") : t("loopOne")}
								aria-pressed={loopMode !== "off"}
								className={cn(loopMode !== "off" && "text-primary")}
								onClick={() => {
									audioEngine.setLoopMode(nextLoopMode(loopMode))
								}}
							>
								<LoopIcon />
							</Button>
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
							<li
								key={queueTrack.uuid}
								className={cn(
									"group/qrow flex items-center gap-2 rounded-lg px-1 pr-1.5",
									index === currentIndex && "bg-muted"
								)}
							>
								<button
									type="button"
									aria-current={index === currentIndex ? "true" : undefined}
									className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
									onClick={() => {
										void audioEngine.playIndex(index)
									}}
								>
									{/* Leading slot: the current row shows loading/error state; any row with a cached cover
									    shows a thumb (cached-only — never triggers a fetch); everything else is the plain
									    track number. */}
									{index === currentIndex && status === "loading" ? (
										<Spinner className="size-4 shrink-0 text-primary" />
									) : index === currentIndex && lastError !== null ? (
										<AlertCircle className="size-4 shrink-0 text-destructive" />
									) : coverUrlsByUuid[queueTrack.uuid] ? (
										<img
											src={coverUrlsByUuid[queueTrack.uuid]}
											alt=""
											className="size-5 shrink-0 rounded object-cover"
										/>
									) : (
										<span
											className={cn(
												"w-5 shrink-0 text-right text-xs tabular-nums",
												index === currentIndex ? "text-primary" : "text-muted-foreground"
											)}
										>
											{index + 1}
										</span>
									)}
									<span
										title={queueTrack.name}
										className={cn(
											"min-w-0 flex-1 truncate text-sm",
											index === currentIndex && "font-medium text-primary"
										)}
									>
										{queueTrack.name}
									</span>
								</button>
								<Button
									variant="ghost"
									size="icon-xs"
									aria-label={t("removeFromQueue")}
									className="shrink-0 opacity-0 transition-opacity group-hover/qrow:opacity-100 focus-visible:opacity-100"
									onClick={() => {
										void audioEngine.removeAt(index)
									}}
								>
									<X />
								</Button>
							</li>
						))}
					</ul>
				</>
			)}
		</div>
	)
}
