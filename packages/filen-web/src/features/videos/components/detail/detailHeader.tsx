import { useState, type CSSProperties, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { ArrowLeftIcon } from "lucide-react"
import { cn } from "@filen/shared"
import type { Rgb } from "@/lib/media/framePick.logic"
import { useVideoArt, type VideoArt } from "@/features/videos/hooks/useVideoArt"
import { neutralTone } from "@/features/videos/lib/videoCard.logic"
import type { DetailHeaderMode, Slot } from "@/features/videos/lib/titleDetail.logic"
import { ArtImage } from "@/features/videos/components/videoCard"
import { useIsNarrowViewport } from "@/features/shell/hooks/useIsNarrowViewport"
import { Button } from "@/components/ui/button"

// The detail pages' header: a cinematic backdrop with the poster and text over its scrim when the title has a
// real backdrop, else the playlist-pane header under a 96 px band of the poster's dominant colour. One component,
// one slot order (back, art, eyebrow, heading, metadata, actions); only the frame around them switches.

function rgb([r, g, b]: Rgb, alpha = 1): string {
	return `rgb(${String(r)} ${String(g)} ${String(b)} / ${String(alpha)})`
}

function bandStyle(dominant: Rgb | null, title: string): CSSProperties {
	return {
		background:
			dominant === null
				? `linear-gradient(160deg, ${neutralTone(title)}, transparent)`
				: `linear-gradient(160deg, ${rgb(dominant, 0.85)}, ${rgb(dominant, 0.25)})`
	}
}

function PosterArt({ art, title, className }: { art: VideoArt; title: string; className: string }) {
	return (
		<div
			aria-hidden="true"
			className={cn("relative shrink-0 overflow-hidden rounded-2xl bg-muted/40 shadow-sm", className)}
			style={art.kind === "image" && art.dominant !== null ? { backgroundColor: rgb(art.dominant, 0.6) } : undefined}
		>
			{art.kind === "image" ? (
				<ArtImage
					key={art.url}
					url={art.url}
					fit={art.fit}
				/>
			) : art.kind === "text" ? (
				<div
					className="absolute inset-0 flex items-end p-3 text-white"
					style={{ backgroundColor: neutralTone(title) }}
				>
					<p className="line-clamp-4 text-base leading-tight font-semibold tracking-tight break-words">{title}</p>
				</div>
			) : null}
		</div>
	)
}

export function DetailTopBar({ onBack, menu }: { onBack: () => void; menu: ReactNode }) {
	const { t } = useTranslation("videos")

	return (
		<div className="flex h-12 shrink-0 items-center justify-between gap-2 px-3">
			<Button
				variant="ghost"
				size="sm"
				onClick={onBack}
			>
				<ArrowLeftIcon data-icon="inline-start" />
				{t("detailBack")}
			</Button>
			{menu}
		</div>
	)
}

export interface DetailHeaderProps {
	mode: DetailHeaderMode
	titleId: string
	title: string
	headingId: string
	eyebrow: string
	onBack: () => void
	menu: ReactNode
	// Metadata lines under the heading, then the action row and its progress.
	meta: ReactNode
	actions: ReactNode
}

export function DetailHeader({ mode, titleId, title, headingId, eyebrow, onBack, menu, meta, actions }: DetailHeaderProps) {
	const [posterElement, setPosterElement] = useState<HTMLDivElement | null>(null)
	const [backdropElement, setBackdropElement] = useState<HTMLDivElement | null>(null)
	// Below the layout breakpoint both forms stack as the phone layout: a backdrop is a 16:9 strip on top.
	const narrow = useIsNarrowViewport()
	const cinematic = mode === "backdrop"
	const overlay = cinematic && !narrow
	// The phone's backdrop strip shows no poster, so none is looked up or decoded there.
	const poster = useVideoArt({ titleId, stableUuid: null, slot: "p", title, near: !cinematic || overlay, element: posterElement })
	const backdrop = useVideoArt({ titleId, stableUuid: null, slot: "b", title, near: cinematic, element: backdropElement })
	const text = (
		<div className={cn("flex min-w-0 flex-1 flex-col gap-1", narrow && "items-center text-center")}>
			<p className={cn("text-xs font-medium text-muted-foreground", cinematic && "sr-only")}>{eyebrow}</p>
			<h1
				id={headingId}
				title={title}
				className="line-clamp-2 text-2xl font-semibold tracking-tight break-words sm:text-3xl"
			>
				{title}
			</h1>
			{meta}
			<div className="mt-3 flex flex-col gap-2">{actions}</div>
		</div>
	)

	if (cinematic) {
		return (
			<header className="relative isolate">
				<DetailTopBar
					onBack={onBack}
					menu={menu}
				/>
				<div
					ref={setBackdropElement}
					aria-hidden="true"
					className={cn("relative w-full overflow-hidden bg-black", overlay ? "h-[clamp(320px,55vh,640px)]" : "aspect-video")}
					style={{ background: `radial-gradient(120% 140% at 85% 10%, ${neutralTone(title)}, #000 70%)` }}
				>
					{backdrop.kind === "image" ? (
						<ArtImage
							key={backdrop.url}
							url={backdrop.url}
							fit="cover"
						/>
					) : null}
					<div className="absolute inset-0 bg-linear-to-b from-black/50 via-transparent to-transparent" />
					{overlay ? <div className="absolute inset-0 bg-linear-to-t from-black/90 via-black/50 to-transparent" /> : null}
				</div>
				<div
					className={cn(
						"flex gap-5 px-4 pb-6 md:px-6",
						overlay ? "dark absolute inset-x-0 bottom-0 flex-row items-end text-foreground" : "flex-col items-center pt-5"
					)}
				>
					{overlay ? (
						<div ref={setPosterElement}>
							<PosterArt
								art={poster}
								title={title}
								className="aspect-[2/3] w-40"
							/>
						</div>
					) : null}
					{text}
				</div>
			</header>
		)
	}

	return (
		<header className="relative isolate">
			<div
				aria-hidden="true"
				className="absolute inset-x-0 top-0 -z-10 h-24"
				style={bandStyle(poster.kind === "image" ? poster.dominant : null, title)}
			/>
			<DetailTopBar
				onBack={onBack}
				menu={menu}
			/>
			<div className={cn("flex gap-5 px-4 pt-12 pb-6 md:px-6", narrow ? "flex-col items-center" : "flex-row items-end")}>
				<div ref={setPosterElement}>
					<PosterArt
						art={poster}
						title={title}
						className={narrow ? "aspect-[2/3] w-32" : "aspect-[2/3] w-40"}
					/>
				</div>
				{text}
			</div>
		</header>
	)
}

// A probe-dependent value: its room is held while the probe is out, and it fades in once known.
export function SlotFade({ slot, children, placeholder }: { slot: Slot<unknown>; children: ReactNode; placeholder: string }) {
	if (slot.state === "empty") {
		return null
	}

	return slot.state === "pending" ? (
		<span
			aria-hidden="true"
			className="invisible"
		>
			{placeholder}
		</span>
	) : (
		<span className="animate-in duration-200 fade-in motion-reduce:animate-none">{children}</span>
	)
}

// A resume point's bar and what is left.
export function ResumeBar({ progress, label }: { progress: number; label: string }) {
	return (
		<div className="flex max-w-sm items-center gap-3">
			<div
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(progress * 100)}
				aria-valuetext={label}
				className="h-1 flex-1 overflow-hidden rounded-full bg-foreground/15"
			>
				<div
					className="h-full bg-primary"
					style={{ width: `${String(Math.max(2, progress * 100))}%` }}
				/>
			</div>
			<span className="shrink-0 text-xs text-muted-foreground tabular-nums">{label}</span>
		</div>
	)
}
