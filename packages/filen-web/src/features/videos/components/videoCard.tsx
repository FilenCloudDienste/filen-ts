import { useEffect, useState, type CSSProperties, type MouseEvent } from "react"
import { useTranslation } from "react-i18next"
import { Link } from "@tanstack/react-router"
import { CheckIcon, MoreHorizontalIcon, PlayIcon } from "lucide-react"
import { cn } from "@filen/shared"
import type { Rgb } from "@/lib/media/framePick.logic"
import { useTouchLongPress } from "@/lib/useTouchLongPress"
import { stopRowPropagation } from "@/lib/domEvents"
import { useVideoArt, type VideoArt } from "@/features/videos/hooks/useVideoArt"
import type { CardObserver } from "@/features/videos/lib/cardObserver"
import type { VideoCardModel } from "@/features/videos/lib/homeRows.logic"
import { cardHeading, cardLabel, episodeCode, neutralTone, sublineText } from "@/features/videos/lib/videoCard.logic"
import { qualityLabel } from "@/features/videos/lib/videoGrid.logic"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { MenuKbd } from "@/lib/keymap/kbdHints"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

export type VideoCardAction = "play" | "markWatched" | "markUnwatched" | "hide"

export interface VideoCardProps {
	card: VideoCardModel
	// Fixed width in a row; a grid card fills its cell.
	width?: number | undefined
	// Tells when the card nears the visible part of its row or grid; null while nothing may load.
	nearObserver: CardObserver | null
	// The roving cursor: one card of a row set or grid carries the tab stop.
	active: boolean
	registerRef?: ((element: HTMLAnchorElement | null) => void) | undefined
	onFocusCard?: (() => void) | undefined
	onAction: (action: VideoCardAction, card: VideoCardModel) => void
	// Position in a virtualized grid, which mounts only part of its cards.
	posInSet?: number | undefined
	setSize?: number | undefined
}

// No iOS link preview or text selection on a long-press, which opens the card's menu instead.
const LINK_CLASS = "block rounded-xl outline-none select-none [-webkit-touch-callout:none]"

const BADGE_CLASS =
	"absolute flex size-6 items-center justify-center rounded-full bg-background/80 text-[11px] font-medium shadow-sm tabular-nums"

function placeholderStyle(dominant: Rgb | null): CSSProperties | undefined {
	if (dominant === null) {
		return undefined
	}

	const [r, g, b] = dominant

	return {
		background: `linear-gradient(160deg, rgb(${String(r)} ${String(g)} ${String(b)}), rgb(${String(r)} ${String(g)} ${String(b)} / 0.6))`
	}
}

// Decoded off the main thread before it shows, then faded in over the placeholder.
export function ArtImage({ url, fit }: { url: string; fit: "cover" | "contain" }) {
	const [ready, setReady] = useState(false)

	return (
		<img
			ref={element => {
				if (element === null || ready) {
					return
				}

				element
					.decode()
					.catch(() => undefined)
					.finally(() => {
						setReady(true)
					})
			}}
			src={url}
			alt=""
			decoding="async"
			draggable={false}
			className={cn(
				"absolute inset-0 size-full transition-opacity duration-150 motion-reduce:transition-none",
				fit === "cover" ? "object-cover" : "object-contain",
				ready ? "opacity-100" : "opacity-0"
			)}
		/>
	)
}

// No image: the title set on a neutral tone chosen by the title, with the year or episode and what is known of it.
function TitleSet({ card }: { card: VideoCardModel }) {
	const item = card.item
	const code = item?.itemClass === "episode" ? episodeCode(item) : ""
	const quality = qualityLabel(card.title.height)

	return (
		<div
			aria-hidden="true"
			className="absolute inset-0 flex flex-col justify-between p-3 text-white"
			style={{ backgroundColor: neutralTone(card.title.title) }}
		>
			<div className="min-w-0">
				<p
					className={cn(
						"font-semibold tracking-tight break-words",
						card.shape === "poster" ? "line-clamp-4 text-base leading-tight" : "line-clamp-2 text-sm"
					)}
				>
					{card.title.title}
				</p>
				{code.length > 0 ? <p className="mt-0.5 text-xs text-white/75">{code.replace(/^S(\d+)E/, "S$1 · E")}</p> : null}
				{item !== null && item.episodeTitle.length > 0 ? (
					<p className="line-clamp-1 text-xs text-white/75">{item.episodeTitle}</p>
				) : null}
			</div>
			{card.shape === "poster" && (card.title.year > 0 || quality.length > 0) ? (
				<p className="flex gap-2 text-xs text-white/75 tabular-nums">
					{card.title.year > 0 ? <span>{card.title.year}</span> : null}
					{quality.length > 0 ? <span>{quality}</span> : null}
				</p>
			) : null}
		</div>
	)
}

function CardArt({ card, art }: { card: VideoCardModel; art: VideoArt }) {
	if (art.kind === "text") {
		return <TitleSet card={card} />
	}

	if (art.kind === "image") {
		return (
			<div
				className="absolute inset-0"
				style={placeholderStyle(art.dominant)}
			>
				<ArtImage
					key={art.url}
					url={art.url}
					fit={art.fit}
				/>
			</div>
		)
	}

	return null
}

// A poster (2:3) or landscape (16:9) card: art with its badges and progress, the caption below. The card itself is
// the link to the title's page (its name says title, year, progress and badges); Play, which opens the player
// straight away, and the menu are separate controls.
export function VideoCard({ card, width, nearObserver, active, registerRef, onFocusCard, onAction, posInSet, setSize }: VideoCardProps) {
	const { t } = useTranslation("videos")
	const [element, setElement] = useState<HTMLDivElement | null>(null)
	const [artElement, setArtElement] = useState<HTMLDivElement | null>(null)
	const [menuOpen, setMenuOpen] = useState(false)
	const [observedNear, setObservedNear] = useState(false)

	useEffect(() => {
		if (element === null || nearObserver === null) {
			return
		}

		return nearObserver.observe(element, setObservedNear)
	}, [element, nearObserver])

	const near = nearObserver !== null && observedNear
	const art = useVideoArt({
		titleId: card.title.id,
		stableUuid: card.item?.stableUuid ?? null,
		slot: card.slot,
		title: card.title.title,
		near,
		element: artElement
	})
	const press = useTouchLongPress<HTMLDivElement>({
		onLongPress: () => {
			setMenuOpen(true)
		},
		onContextMenu: (event: MouseEvent<HTMLDivElement>) => {
			event.preventDefault()
			setMenuOpen(true)
		}
	})
	const heading = cardHeading(card)
	const label = cardLabel(card, t)
	const played = card.badge?.kind === "watched" || card.progress !== null
	const face = (
		<>
			<div
				ref={setArtElement}
				className={cn(
					"relative w-full overflow-hidden rounded-xl bg-muted/40 transition-[transform,box-shadow] duration-200 motion-reduce:transition-none",
					"group-has-[a:focus-visible]/tile:ring-2 group-has-[a:focus-visible]/tile:ring-ring",
					"motion-safe:group-has-[a:focus-visible]/tile:scale-105 motion-safe:group-has-[a:focus-visible]/tile:shadow-lg motion-safe:pointer-fine:group-hover/tile:scale-105 motion-safe:pointer-fine:group-hover/tile:shadow-lg",
					card.shape === "poster" ? "aspect-[2/3]" : "aspect-video"
				)}
			>
				{/* Only an image is dimmed: the title set keeps its contrast. */}
				<div className={cn("absolute inset-0", card.unsupported && art.kind === "image" && "opacity-60")}>
					<CardArt
						card={card}
						art={art}
					/>
				</div>
				<div aria-hidden="true">
					{card.unsupported ? (
						<Badge
							variant="secondary"
							className="absolute bottom-2 left-2"
						>
							{t("videosCardNotPlayable")}
						</Badge>
					) : null}
					{card.badge?.kind === "unwatched" ? (
						<span className={cn(BADGE_CLASS, "bottom-1 left-1 w-auto min-w-6 px-1.5")}>{card.badge.count}</span>
					) : null}
					{card.badge?.kind === "watched" ? (
						<span className={cn(BADGE_CLASS, "right-1 bottom-1")}>
							<CheckIcon className="size-3.5" />
						</span>
					) : null}
					{card.progress === null ? null : (
						<div className="absolute inset-x-0 bottom-0 h-[3px] bg-foreground/15">
							<div
								className="h-full bg-primary"
								style={{ width: `${String(Math.max(2, card.progress * 100))}%` }}
							/>
						</div>
					)}
				</div>
			</div>
			<div
				aria-hidden="true"
				className="mt-2 min-w-0 px-0.5"
			>
				<p className={cn("truncate text-sm font-medium", played && "text-foreground/90")}>{heading}</p>
				{card.sublines.map((subline, index) => (
					<p
						key={index}
						className="truncate text-xs text-muted-foreground tabular-nums"
					>
						{sublineText(subline, t)}
					</p>
				))}
			</div>
		</>
	)

	return (
		<div
			ref={setElement}
			role="listitem"
			aria-posinset={posInSet}
			aria-setsize={setSize}
			className="group/tile relative shrink-0 snap-start focus-within:z-10 hover:z-10"
			style={width === undefined ? undefined : { width }}
			{...press.handlers}
		>
			<Link
				ref={registerRef}
				to="/videos/title/$uuid"
				params={{ uuid: card.title.id }}
				data-video-card=""
				aria-label={label}
				tabIndex={active ? 0 : -1}
				draggable={false}
				className={LINK_CLASS}
				onFocus={onFocusCard}
			>
				{face}
			</Link>
			{card.play === null ? null : (
				<button
					type="button"
					tabIndex={-1}
					aria-label={t("videosCardPlayLabel", { title: heading })}
					className={cn(
						// Takes pointer input only while shown, so an invisible button never catches a tap meant for the card.
						"pointer-events-none absolute top-0 left-1/2 flex size-10 -translate-x-1/2 items-center justify-center rounded-full bg-black/60 text-white opacity-0 shadow-lg transition-opacity duration-150",
						"pointer-fine:group-hover/tile:pointer-events-auto pointer-fine:group-hover/tile:opacity-100",
						card.shape === "poster" ? "mt-[calc(75%-1.25rem)]" : "mt-[calc(28.125%-1.25rem)]"
					)}
					onClick={event => {
						stopRowPropagation(event)
						onAction("play", card)
					}}
				>
					<PlayIcon className="size-4 fill-current" />
				</button>
			)}
			<DropdownMenu
				open={menuOpen}
				onOpenChange={setMenuOpen}
			>
				<DropdownMenuTrigger
					render={
						<Button
							variant="secondary"
							size="icon-xs"
							aria-label={t("videosCardMenu", { title: heading })}
							tabIndex={active ? 0 : -1}
							className="absolute top-1.5 right-1.5 rounded-full bg-background/80 opacity-0 shadow-sm group-hover/tile:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 pointer-coarse:size-8 pointer-coarse:opacity-100"
							onClick={stopRowPropagation}
						>
							<MoreHorizontalIcon />
						</Button>
					}
				/>
				<DropdownMenuContent align="end">
					{card.play === null ? null : (
						<DropdownMenuItem
							onClick={() => {
								onAction("play", card)
							}}
						>
							<PlayIcon />
							{card.resumeSec > 0 ? t("videosCardResume") : t("videosCardPlay")}
							<MenuKbd action="videos.play" />
						</DropdownMenuItem>
					)}
					{card.unsupported ? null : card.badge?.kind === "watched" ? (
						<DropdownMenuItem
							onClick={() => {
								onAction("markUnwatched", card)
							}}
						>
							{t("videosCardMarkUnwatched")}
							<MenuKbd action="videos.toggleWatched" />
						</DropdownMenuItem>
					) : (
						<DropdownMenuItem
							onClick={() => {
								onAction("markWatched", card)
							}}
						>
							<CheckIcon />
							{t("videosCardMarkWatched")}
							<MenuKbd action="videos.toggleWatched" />
						</DropdownMenuItem>
					)}
					{card.hideable ? (
						<DropdownMenuItem
							onClick={() => {
								onAction("hide", card)
							}}
						>
							{t("videosCardHide")}
							<MenuKbd action="videos.hide" />
						</DropdownMenuItem>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	)
}
