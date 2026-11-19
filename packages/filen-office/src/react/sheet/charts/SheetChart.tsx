import { useEffect, useRef, useState } from "react"
import type { ChartRender } from "../../../core/xlsx/charts/render"
import type { DocxMedia } from "../../../dom/docx/protocol"
import { DocxMediaCache } from "../../docx/media"
import { drawingImages, imageMime, paintDrawing } from "../../docx/paint/drawing"
import { textMeasurer } from "../../docx/paint/objects"

// A chart drawn as SVG from its display list (the charts feature lays it out at its frame's size at 100 %; the SVG
// scales with the frame, so zooming scales text and lines as Excel does). It asks again whenever `version` moves (an
// edit, undo or recalculation): the session answers "same" at once unless the chart's part or the cells it reads
// changed, so a chart redraws only when what it shows did.

export interface SheetChartSource {
	render(part: string, width: number, height: number, since: string | undefined): Promise<ChartRender>
	// A picture a chart shows (a picture fill): the session's drawing.media.
	media(partName: string): Promise<DocxMedia | null>
}

export interface SheetChartProps {
	readonly part: string
	// The frame at 100 % zoom, px.
	readonly width: number
	readonly height: number
	readonly source: SheetChartSource
	// The session's document version (SheetDocState.version).
	readonly version: number
}

const EMU_PER_PX = 9525

let painted = 0

// A safe id prefix unique per painted chart on the page.
function idPrefix(): string {
	painted += 1

	return `foc${String(painted)}-`
}

export function SheetChart(props: SheetChartProps) {
	const host = useRef<HTMLDivElement>(null)
	// The stamp of what the host shows: a request with it answers "same" when nothing changed.
	const shown = useRef<string | undefined>(undefined)
	// The pictures the shown drawing uses, released when another replaces it or the chart goes.
	const shownMedia = useRef<{ partName: string; type: string }[]>([])
	const [state, setState] = useState<"drawn" | "pending" | "placeholder">("pending")
	const { part, source, version } = props
	// Pictures are read once and lent as object URLs while shown.
	const [media] = useState(() => new DocxMediaCache({ media: partName => source.media(partName) }))
	const width = Math.max(1, Math.round(props.width))
	const height = Math.max(1, Math.round(props.height))

	useEffect(() => () => media.dispose(), [media])

	useEffect(() => {
		let cancelled = false
		const held: { partName: string; type: string }[] = []
		const release = (entries: readonly { partName: string; type: string }[]): void => {
			for (const entry of entries) media.release(entry.partName, entry.type)
		}

		void (async () => {
			const rendered = await source.render(part, width * EMU_PER_PX, height * EMU_PER_PX, shown.current)

			if (cancelled || rendered.kind === "same") return

			if (rendered.kind === "placeholder") {
				shown.current = rendered.stamp
				host.current?.replaceChildren()
				setState("placeholder")

				return
			}

			const urls = new Map<string, string | undefined>()

			await Promise.all(
				drawingImages(rendered.drawing).map(async image => {
					const partName = image.svgPartName ?? image.partName
					const type = imageMime(image)

					if (partName === undefined || type === "") return

					held.push({ partName, type })
					urls.set(partName, await media.acquire(partName, type))
				})
			)

			if (cancelled) {
				release(held)

				return
			}

			const svg = paintDrawing(rendered.drawing, {
				document,
				idPrefix: idPrefix(),
				measureText: textMeasurer(document),
				imageUrl: image => urls.get(image.svgPartName ?? image.partName ?? "")
			})

			svg.setAttribute("aria-hidden", "true")
			host.current?.replaceChildren(svg)
			release(shownMedia.current)
			shownMedia.current = held
			shown.current = rendered.stamp
			setState("drawn")
		})().catch(() => {
			release(held)

			if (!cancelled) setState("placeholder")
		})

		return () => {
			cancelled = true
		}
	}, [part, width, height, source, media, version])

	return (
		<div
			className="fo-sheet-chart"
			data-state={state}
			style={{
				position: "absolute",
				inset: 0,
				pointerEvents: "none",
				...(state === "placeholder" && {
					background: "var(--fo-placeholder-fill, #f1f1f1)",
					border: "1px solid var(--fo-placeholder-stroke, #c8c8c8)"
				})
			}}
		>
			<div
				ref={host}
				style={{ position: "absolute", inset: 0 }}
			/>
		</div>
	)
}
