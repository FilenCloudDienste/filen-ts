import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { PlayIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { StageCornerCard } from "@/components/media/video/stageCards"

// The next episode in the corner, a countdown bar and the seconds in the Play button. Both follow the
// playhead (a pause holds them), and neither re-renders: the bar is a compositor transform animation kept
// at the playhead's offset, the number is written into the button on timeupdate. Focus stays where it is; the
// stage's live region announces it (a region mounted with its text is not read out).

export function UpNextCard({
	video,
	title,
	detail,
	still,
	showAt,
	autoplayAt,
	onPlay,
	onDismiss
}: {
	video: HTMLVideoElement | null
	title: string
	detail: string | null
	still: string | null
	showAt: number
	autoplayAt: number
	onPlay: () => void
	onDismiss: () => void
}) {
	const { t } = useTranslation("videos")
	const barRef = useRef<HTMLDivElement>(null)
	const countRef = useRef<HTMLSpanElement>(null)

	useEffect(() => {
		const bar = barRef.current

		if (video === null || bar === null) {
			return
		}

		const element = video
		const span = Math.max(1, autoplayAt - showAt)
		const animation = bar.animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], {
			duration: span * 1000,
			fill: "forwards",
			easing: "linear"
		})
		let shown = -1

		function sync(): void {
			const elapsed = Math.max(0, Math.min(span, element.currentTime - showAt))
			const left = Math.max(0, Math.ceil(autoplayAt - element.currentTime))

			animation.currentTime = elapsed * 1000

			if (element.paused || element.playbackRate === 0) {
				animation.pause()
			} else {
				animation.playbackRate = element.playbackRate
				animation.play()
			}

			if (left !== shown && countRef.current !== null) {
				shown = left
				countRef.current.textContent = String(left)
			}
		}

		function tick(): void {
			const left = Math.max(0, Math.ceil(autoplayAt - element.currentTime))

			if (left !== shown && countRef.current !== null) {
				shown = left
				countRef.current.textContent = String(left)
			}
		}

		sync()

		const syncEvents = ["play", "pause", "seeked", "ratechange"]

		for (const event of syncEvents) {
			element.addEventListener(event, sync)
		}

		element.addEventListener("timeupdate", tick)

		return () => {
			animation.cancel()

			for (const event of syncEvents) {
				element.removeEventListener(event, sync)
			}

			element.removeEventListener("timeupdate", tick)
		}
	}, [video, showAt, autoplayAt])

	return (
		<StageCornerCard label={t("upNextLabel")}>
			<p className="mb-2 text-xs font-medium text-muted-foreground">{t("upNextLabel")}</p>
			<div className="flex gap-3">
				<div className="aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-white/10">
					{still === null ? null : (
						<img
							src={still}
							alt=""
							className="size-full object-cover thumbnail-range"
						/>
					)}
				</div>
				<div className="flex min-w-0 flex-col justify-center gap-0.5">
					<p className="line-clamp-2 font-medium">{title}</p>
					{detail === null ? null : <p className="text-xs text-muted-foreground">{detail}</p>}
				</div>
			</div>
			<div className="mt-3 flex items-center gap-2">
				<Button
					size="sm"
					className="bg-white text-black hover:bg-white/85"
					onClick={onPlay}
				>
					<PlayIcon className="fill-current" />
					{t("upNextPlayNow")}
					<span
						ref={countRef}
						aria-hidden="true"
						className="min-w-4 text-center tabular-nums opacity-70"
					/>
				</Button>
				<Button
					variant="ghost"
					size="sm"
					onClick={onDismiss}
				>
					{t("upNextWatchCredits")}
				</Button>
			</div>
			<div className="mt-3 h-0.5 w-full overflow-hidden rounded-full bg-white/15">
				<div
					ref={barRef}
					className="h-full w-full origin-left bg-white"
				/>
			</div>
		</StageCornerCard>
	)
}
