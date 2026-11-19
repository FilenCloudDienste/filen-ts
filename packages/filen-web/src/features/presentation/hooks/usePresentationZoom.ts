import { useEffect, useState, type RefObject } from "react"
import {
	presentationWheelZoom,
	presentationZoom,
	type PresentationZoom,
	type PresentationZoomChange
} from "@/features/presentation/lib/zoom"
import { useLatestRef } from "@/lib/useLatestRef"

// The slide view's zoom, the editor's and the read-only viewer's alike: the scale the view shows (screen px per slide
// px, fitting or at the zoom, which SlideView reports through `setScale`), fit to the window or a zoom (this session's
// only, never written to the file), its steps, and Ctrl/Cmd+wheel (a trackpad pinch) on the canvas. The canvas element
// must exist when the caller mounts: the wheel listener is added to it once.
export function usePresentationZoom(canvasRef: RefObject<HTMLElement | null>): {
	readonly scale: number
	readonly setScale: (scale: number) => void
	readonly zoomMode: PresentationZoom
	readonly zoomBy: (change: PresentationZoomChange) => void
} {
	const [scale, setScale] = useState(1)
	const [zoomMode, setZoomMode] = useState<PresentationZoom>("fit")
	// Read by the steps and the wheel, which build on the zoom shown.
	const scaleRef = useLatestRef(scale)
	const zoomBy = (change: PresentationZoomChange): void => {
		setZoomMode(previous => presentationZoom(previous, scaleRef.current, change))
	}

	// A plain wheel scrolls. A native non-passive listener, so the browser's own page zoom stays out.
	useEffect(() => {
		const canvas = canvasRef.current

		if (canvas === null) return undefined

		const onWheel = (event: WheelEvent): void => {
			if (!event.ctrlKey && !event.metaKey) return

			event.preventDefault()

			const { deltaY } = event

			setZoomMode(previous => presentationWheelZoom(previous, scaleRef.current, deltaY))
		}

		canvas.addEventListener("wheel", onWheel, { passive: false })

		return () => {
			canvas.removeEventListener("wheel", onWheel)
		}
	}, [canvasRef, scaleRef])

	return { scale, setScale, zoomMode, zoomBy }
}
