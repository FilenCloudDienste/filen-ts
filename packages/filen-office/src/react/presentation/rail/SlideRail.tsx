import type { KeyboardEvent } from "react"
import { slideListRows } from "../../../core/presentation/edit/commands/slide"
import type { Section, SlideRef } from "../../../core/presentation/model"
import { PageRail, PageRailThumb, RAIL_ITEM_GAP } from "../../shared/pageRail"
import type { PresentationThumb } from "../store"

// The slide rail: the shared page rail (react/shared/pageRail.tsx) over a deck's slides, each drawing its thumbnail
// bitmap into a canvas. Thumbnails are asked for as items come into view; the store skips fresh and pending ones. A
// deck with sections shows each section's name before its slides. An editor adds a multiple selection (Shift and
// Ctrl/Cmd clicks, Shift with the keys), its own keys, and dragging the selection to another place with a mouse or
// pen (touch scrolls the rail; its context menu moves slides). Structure and data-* attributes only; the look comes
// from presentation.css.

export interface SlideRailProps {
	readonly slides: readonly { readonly ref: SlideRef; readonly hidden: boolean }[]
	readonly thumbs: ReadonlyMap<SlideRef, PresentationThumb>
	// Slide height / width.
	readonly aspect: number
	readonly current: number
	readonly onSelect: (index: number) => void
	readonly requestThumbnails: (refs: readonly SlideRef[], widthPx: number) => void
	readonly label: string
	// `section`: the name of the section this slide starts, for its accessible name.
	readonly slideLabel: (index: number, count: number, hidden: boolean, section?: string) => string
	readonly orientation?: "vertical" | "horizontal"
	// CSS px.
	readonly thumbWidth?: number
	readonly overscan?: number
	readonly className?: string
	// The deck's sections: a header before each section's slides.
	readonly sections?: readonly Section[]
	// The slides selected with the current one (indices); absent: the current slide alone.
	readonly selected?: ReadonlySet<number>
	// Shift (a range from the current slide) or Ctrl/Cmd (a toggle) on a click, Shift with a key.
	readonly onExtend?: (index: number, mode: "range" | "toggle") => void
	// The selection dropped to stand before this slide index (the slide count: at the end).
	readonly onMove?: (before: number) => void
	// The host's keys, before the rail's own: true when it handled the key.
	readonly onCommandKey?: (event: KeyboardEvent<HTMLDivElement>) => boolean
}

export const DEFAULT_THUMB_WIDTH = 160
export { RAIL_ITEM_GAP }
// A section header's extent along the rail (px).
export const RAIL_HEADER_EXTENT = 28
export const RAIL_HEADER_EXTENT_HORIZONTAL = 24

const PREFIX = "fo-slide-rail"

export function SlideRail({
	slides,
	thumbs,
	aspect,
	current,
	onSelect,
	requestThumbnails,
	label,
	slideLabel,
	orientation,
	thumbWidth,
	overscan,
	className,
	sections,
	selected,
	onExtend,
	onMove,
	onCommandKey
}: SlideRailProps) {
	const vertical = orientation !== "horizontal"
	const hasSections = sections !== undefined && sections.length > 0
	const rows = hasSections
		? slideListRows(
				slides.map(slide => slide.ref),
				sections
			)
		: undefined
	// The name of the section each section's first slide starts.
	const startsSection = new Map<number, string>()

	if (rows !== undefined) {
		for (let row = 0; row + 1 < rows.length; row++) {
			const item = rows[row]
			const next = rows[row + 1]

			if (item?.kind === "section" && next?.kind === "slide") startsSection.set(next.index, sections?.[item.section]?.name ?? "")
		}
	}

	return (
		<PageRail
			count={slides.length}
			itemKey={index => slides[index]?.ref ?? index}
			aspect={aspect}
			current={current}
			onSelect={onSelect}
			label={label}
			itemLabel={(index, count) => {
				const section = startsSection.get(index)
				const hidden = slides[index]?.hidden === true

				return section === undefined ? slideLabel(index, count, hidden) : slideLabel(index, count, hidden, section)
			}}
			renderItem={(index, size) => {
				const slide = slides[index]

				return (
					<>
						<span
							className="fo-slide-rail-number"
							aria-hidden="true"
						>
							{index + 1}
						</span>
						<PageRailThumb
							bitmap={slide === undefined ? undefined : thumbs.get(slide.ref)?.bitmap}
							width={size.width}
							height={size.height}
							classPrefix={PREFIX}
						/>
					</>
				)
			}}
			onWindow={(indices, widthPx) => {
				const refs: SlideRef[] = []

				for (const index of indices) {
					const slide = slides[index]

					if (slide !== undefined) refs.push(slide.ref)
				}

				requestThumbnails(refs, widthPx)
			}}
			thumbsVersion={thumbs}
			orientation={vertical ? "vertical" : "horizontal"}
			thumbWidth={thumbWidth ?? DEFAULT_THUMB_WIDTH}
			overscan={overscan ?? 3}
			{...(className === undefined ? {} : { className })}
			classPrefix={PREFIX}
			focusMode="activedescendant"
			{...(rows === undefined ? {} : { rows })}
			headerExtent={vertical ? RAIL_HEADER_EXTENT : RAIL_HEADER_EXTENT_HORIZONTAL}
			renderHeader={section => <span className="fo-slide-rail-section-name">{sections?.[section]?.name ?? ""}</span>}
			itemAttributes={index => ({ "data-fo-hidden": slides[index]?.hidden === true ? "" : undefined })}
			{...(selected === undefined ? {} : { selected })}
			{...(onExtend === undefined ? {} : { onExtend })}
			{...(onMove === undefined ? {} : { onMove })}
			{...(onCommandKey === undefined ? {} : { onCommandKey })}
		/>
	)
}
