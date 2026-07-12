import { useTranslation } from "react-i18next"
import { Shuffle, Repeat, Repeat1, Trash2, X } from "lucide-react"
import { audioEngine } from "@/features/audio/lib/audioEngine"
import { useAudioQueue, useAudioQueueControls } from "@/features/audio/store/useAudioStore"
import { nextLoopMode } from "@/features/audio/components/audioTransport.logic"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// The now-playing panel body (rendered inside the player bar's queue popover): the full queue with the
// current track highlighted, click-to-jump per row, a per-row remove, a clear-queue action, and the
// shuffle/loop toggles (also surfaced on the bar itself — mobile parity puts them in both places). Reads
// the queue reactively; every mutation goes straight to the engine singleton, which drives the store.
export function NowPlayingPanel() {
	const { t } = useTranslation("audio")
	const { queue, currentIndex } = useAudioQueue()
	const { shuffleEnabled, loopMode } = useAudioQueueControls()
	const LoopIcon = loopMode === "one" ? Repeat1 : Repeat

	return (
		<div className="flex max-h-[min(60vh,28rem)] flex-col">
			<div className="flex items-center justify-between gap-2 px-1 pb-2">
				<div className="min-w-0">
					<p className="text-base font-medium">{t("queue")}</p>
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
						className={cn("group/qrow flex items-center gap-2 rounded-lg px-1 pr-1.5", index === currentIndex && "bg-muted")}
					>
						<button
							type="button"
							aria-current={index === currentIndex ? "true" : undefined}
							className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
							onClick={() => {
								void audioEngine.playIndex(index)
							}}
						>
							<span
								className={cn(
									"w-5 shrink-0 text-right text-xs tabular-nums",
									index === currentIndex ? "text-primary" : "text-muted-foreground"
								)}
							>
								{index + 1}
							</span>
							<span
								title={queueTrack.name}
								className={cn("min-w-0 flex-1 truncate text-sm", index === currentIndex && "font-medium text-primary")}
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
		</div>
	)
}
