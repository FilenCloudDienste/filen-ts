import { useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { EMU_PER_PX } from "../../../core/drawingml/index"
import type { ShowScreen } from "./controller"
import type { ShowMirrorLink } from "./mirror"

// The presenter view's current slide: the running show's stage copied live (show/mirror.ts) and letterboxed in its box,
// so it shows what the audience sees at each moment (the builds played so far, a transition under way, a video at its
// playing position, a black or white screen). The box is measured with its own window's ResizeObserver: an observer
// from the page's realm never sees layout in the presenter's popup.

export interface ShowMirrorViewProps {
	readonly link: ShowMirrorLink
	// EMU.
	readonly size: { readonly cx: number; readonly cy: number }
	readonly label: string
	readonly screen: ShowScreen
	// The end screen's line ("End of slide show, click to exit.").
	readonly endLabel?: string
	// Over the slide, at the slide's box (pen and laser).
	readonly overlay?: ReactNode
	readonly className?: string
}

export function ShowMirrorView({ link, size, label, screen, endLabel, overlay, className }: ShowMirrorViewProps) {
	const boxRef = useRef<HTMLDivElement | null>(null)
	const hostRef = useRef<HTMLDivElement | null>(null)
	const [box, setBox] = useState({ width: 0, height: 0, dpr: 1 })
	const slideWidth = size.cx / EMU_PER_PX
	const slideHeight = size.cy / EMU_PER_PX
	const scale =
		box.width > 0 && box.height > 0 && slideWidth > 0 && slideHeight > 0
			? Math.min(box.width / slideWidth, box.height / slideHeight)
			: 0
	const ratio = scale * box.dpr

	useLayoutEffect(() => {
		const element = boxRef.current

		if (element === null) return

		const View = element.ownerDocument.defaultView
		const read = (): void => {
			const width = element.clientWidth
			const height = element.clientHeight
			const dpr = View?.devicePixelRatio ?? 1

			setBox(previous =>
				previous.width === width && previous.height === height && previous.dpr === dpr ? previous : { width, height, dpr }
			)
		}
		const observer = View === null || typeof View.ResizeObserver !== "function" ? undefined : new View.ResizeObserver(read)

		read()
		observer?.observe(element)

		return () => observer?.disconnect()
	}, [])

	useLayoutEffect(() => {
		const host = hostRef.current

		if (host === null) return

		link.view(host)

		return () => {
			link.view(undefined)
		}
	}, [link])

	useLayoutEffect(() => {
		link.resize(ratio)
	}, [link, ratio])

	const width = slideWidth * scale
	const height = slideHeight * scale

	return (
		<div
			ref={boxRef}
			role="img"
			aria-label={label}
			className={className}
			data-fo-show-mirror=""
			data-fo-screen={screen}
			style={{ position: "relative", overflow: "hidden", background: screen === "white" ? "#fff" : "#000" }}
		>
			<div
				className="fo-show-viewport"
				style={{ left: (box.width - width) / 2, top: (box.height - height) / 2, width, height }}
			>
				<div
					ref={hostRef}
					className="fo-show-host"
					aria-hidden="true"
					inert
					style={{ width: slideWidth, height: slideHeight, transform: `scale(${String(scale)})` }}
				/>
				{overlay}
			</div>
			{screen === "end" && endLabel !== undefined ? (
				<div
					className="fo-show-end"
					aria-hidden="true"
				>
					{endLabel}
				</div>
			) : null}
		</div>
	)
}
