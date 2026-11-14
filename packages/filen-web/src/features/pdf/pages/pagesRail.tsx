import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react"
import { useTranslation } from "react-i18next"
import { RotateCcwIcon, RotateCwIcon, Trash2Icon } from "lucide-react"
import { moveBeforeOrder, shiftOrder } from "@filen/office/core/pdfedit/pageOrder"
import { PageRail, PageRailThumb } from "@filen/office/react/shared/pageRail"
import "@filen/office/css/pageRail.css"
import { actionPages, extendSelection, selectAll, toggleSelection } from "@/features/pdf/pages/organise.logic"
import { PageThumbnails, thumbnailWindow, type RenderThumbnail } from "@/features/pdf/pages/thumbnails"

// The PDF's pages as thumbnails: the rail beside the pages, or the Organise grid. Selection lives here as values in
// and callbacks out; every page change is a callback with the pages it applies to (or the new order), which the host
// turns into one engine command. The host also gives the live region's sentence after each change.

export interface PdfRailPage {
	// Stable across moves (the session's page id): a moved page keeps its thumbnail.
	readonly id: string
	// Points, as shown (rotation applied).
	readonly width: number
	readonly height: number
}

export interface PdfPagesRailProps {
	readonly pages: readonly PdfRailPage[]
	readonly current: number
	readonly selected: ReadonlySet<number>
	readonly onSelect: (index: number) => void
	readonly onSelectionChange: (selected: Set<number>) => void
	readonly renderThumbnail: RenderThumbnail
	readonly layout: "rail" | "grid"
	// Page changes are allowed (not signed, not restricted, editable): drag, Alt+arrows, Delete and hover actions.
	readonly editable: boolean
	// The new order (old indices in their new order).
	readonly onReorder: (order: number[]) => void
	readonly onRotate: (pages: number[], degrees: 90 | -90) => void
	readonly onDelete: (pages: number[]) => void
	// The host's keys first (rotate, duplicate from the keymap): true when handled.
	readonly onCommandKey?: (event: KeyboardEvent<HTMLDivElement>) => boolean
	// Ids of pages whose look changed since the last render (rotated, cropped): their thumbnails are drawn again.
	readonly changed?: readonly string[]
	readonly announcement?: string
	readonly className?: string
	// pdf.js reads the document in ranges and draws the thumbnails: only pages in view get one, and until the user
	// scrolls or moves through the rail only those next to the page shown (thumbnailWindow).
	readonly sparing?: boolean
}

// Thumbnails stay small (plan: ≤ 96 px wide in the rail); the grid shows them larger.
export const RAIL_THUMB_WIDTH = 96
export const GRID_THUMB_WIDTH = 144
// What an item adds around its thumbnail (pageRail.css: 6 px padding each side), and the number line under it.
const ITEM_CHROME = 12
// Rail overscan: rows mounted (and thumbnails kept) beyond the view on each side.
const OVERSCAN = 4

// The tallest page's aspect, bounded: every cell has room for the tallest thumbnail, wider ones are letterboxed.
function cellAspect(pages: readonly PdfRailPage[]): number {
	let aspect = 0

	for (const page of pages) if (page.width > 0) aspect = Math.max(aspect, page.height / page.width)

	return Math.max(0.5, Math.min(2, aspect === 0 ? Math.SQRT2 : aspect))
}

export function PdfPagesRail({
	pages,
	current,
	selected,
	onSelect,
	onSelectionChange,
	renderThumbnail,
	layout,
	editable,
	onReorder,
	onRotate,
	onDelete,
	onCommandKey,
	changed,
	announcement,
	className,
	sparing
}: PdfPagesRailProps) {
	const { t } = useTranslation("preview")
	const [store] = useState(() => {
		const listeners = new Set<() => void>()
		const thumbnails = new PageThumbnails(renderThumbnail, () => {
			for (const listener of listeners) listener()
		})
		const subscribe = (listener: () => void): (() => void) => {
			listeners.add(listener)

			return () => {
				listeners.delete(listener)
			}
		}

		return { thumbnails, subscribe, version: () => thumbnails.version }
	})
	// The rail's mounted pages as last reported, so a new page shown or the first scroll asks again.
	const mounted = useRef<{
		readonly windowed: readonly { id: string; page: number }[]
		readonly inView: number
		readonly widthPx: number
	}>({
		windowed: [],
		inView: 0,
		widthPx: 0
	})
	// The user scrolled or moved through the rail: the pages in view are wanted, wherever the view is. The Organise grid
	// is opened to see the pages, so it starts explored.
	const [explored, setExplored] = useState(layout === "grid")
	const version = useSyncExternalStore(store.subscribe, store.version)
	const grid = layout === "grid"
	const thumbWidth = grid ? GRID_THUMB_WIDTH : RAIL_THUMB_WIDTH
	const count = pages.length
	const targets = (): number[] => actionPages(selected, current)
	const askThumbnails = (): void => {
		const { windowed, inView, widthPx } = mounted.current
		const wanted = new Set(
			thumbnailWindow(
				windowed.map(entry => entry.page),
				inView,
				sparing === true ? { current, explored } : null
			)
		)

		store.thumbnails.setWindow(
			windowed.filter(entry => wanted.has(entry.page)),
			widthPx
		)
	}
	const ask = useEffectEvent(askThumbnails)
	const explore = (): void => {
		if (!explored) setExplored(true)
	}

	useEffect(() => {
		ask()
	}, [current, explored, sparing])

	useEffect(() => {
		store.thumbnails.setRenderer(renderThumbnail)
	}, [store, renderThumbnail])

	useEffect(
		() => () => {
			store.thumbnails.dispose()
		},
		[store]
	)

	useEffect(() => {
		if (changed !== undefined && changed.length > 0) store.thumbnails.invalidate(changed)
	}, [changed, store])

	// Scrolling or moving through the rail (wheel, touch, a press on it or its scrollbar, keys) is what explores it.
	return (
		<div
			className={className === undefined ? "size-full" : `size-full ${className}`}
			onWheel={explore}
			onTouchStart={explore}
			onPointerDown={explore}
			onKeyDown={explore}
		>
			<PageRail
				count={count}
				itemKey={index => pages[index]?.id ?? index}
				aspect={cellAspect(pages)}
				current={current}
				onSelect={onSelect}
				label={t("previewPdfPagesRailLabel")}
				itemLabel={(index, total) => t("previewPdfPagesItemLabel", { page: index + 1, count: total })}
				renderItem={(index, size) => {
					const page = pages[index]

					return (
						<>
							<PageRailThumb
								bitmap={page === undefined ? undefined : store.thumbnails.get(page.id)}
								width={size.width}
								height={size.height}
								classPrefix="fo-page-rail"
							/>
							<span
								className="text-xs text-muted-foreground tabular-nums"
								aria-hidden="true"
							>
								{index + 1}
							</span>
							{grid && editable ? (
								// Mouse shortcuts over a page; the keys (and the toolbar) do the same for everyone, so these stay out of
								// the accessibility tree and the tab order.
								<span
									className="absolute top-2 right-2 gap-1 rounded-xl bg-background/90 p-0.5 shadow-sm"
									data-fo-hover=""
									aria-hidden="true"
								>
									{(
										[
											["ccw", RotateCcwIcon, t("previewPdfPagesRotateCcw")],
											["cw", RotateCwIcon, t("previewPdfPagesRotateCw")],
											["delete", Trash2Icon, t("previewPdfPagesDelete")]
										] as const
									).map(([action, Icon, title]) => (
										<span
											key={action}
											role="presentation"
											title={title}
											data-pdf-page-action={action}
											className="flex size-6 items-center justify-center rounded-lg hover:bg-muted"
											onPointerDown={event => {
												event.stopPropagation()
											}}
											onClick={event => {
												event.stopPropagation()

												if (action === "delete") onDelete([index])
												else onRotate([index], action === "cw" ? 90 : -90)
											}}
										>
											<Icon className="size-4" />
										</span>
									))}
								</span>
							) : null}
						</>
					)
				}}
				onWindow={(indices, widthPx, inView) => {
					const windowed: { id: string; page: number }[] = []

					for (const index of indices) {
						const page = pages[index]

						if (page !== undefined) windowed.push({ id: page.id, page: index })
					}

					mounted.current = { windowed, inView, widthPx }
					askThumbnails()
				}}
				thumbsVersion={version}
				orientation="vertical"
				layout={grid ? "grid" : "list"}
				thumbWidth={thumbWidth}
				cellChrome={ITEM_CHROME}
				overscan={OVERSCAN}
				className={className === undefined ? "size-full" : `size-full ${className}`}
				focusMode="roving"
				selected={selected}
				onExtend={(index, mode) => {
					onSelectionChange(extendSelection(selected, current, index, mode))

					if (mode === "range") onSelect(index)
				}}
				onToggle={index => {
					onSelectionChange(toggleSelection(selected, index))
				}}
				onSelectAll={() => {
					onSelectionChange(selectAll(count))
				}}
				{...(editable
					? {
							onMove: (before: number) => {
								onReorder(moveBeforeOrder(count, targets(), before))
							},
							onShift: (delta: number) => {
								const order = shiftOrder(count, targets(), delta)

								if (order !== null) onReorder(order)
							},
							onDelete: () => {
								onDelete(targets())
							}
						}
					: {})}
				onMarquee={(indices, additive) => {
					const next = additive ? new Set(selected) : new Set<number>()

					for (const index of indices) next.add(index)

					onSelectionChange(next)
				}}
				{...(onCommandKey === undefined ? {} : { onCommandKey })}
				{...(announcement === undefined ? {} : { announcement })}
			/>
		</div>
	)
}
