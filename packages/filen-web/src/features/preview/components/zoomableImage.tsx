import { use, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react"
import { useReleaseOnUnmount } from "@/lib/media/useReleaseOnUnmount"
import {
	type Size,
	type ZoomTransform,
	wheelZoom,
	dragPan,
	doubleClickZoom,
	pinchZoom
} from "@/features/preview/components/imageViewer.logic"
import { imageKeyTransform, imageViewerKey } from "@/features/preview/lib/imageViewerKeys.logic"
import { keyForEditor } from "@/lib/keymap/dialogGuard"
import { isRecordingCombo, useBindings } from "@/lib/keymap/registry"
import { useLatestRef } from "@/lib/useLatestRef"
import { isImeKeydown } from "@filen/shared/keymap"
import { useObjectUrl } from "@/lib/useObjectUrl"
import { ImageKeyGroupContext, ImageShownContext } from "@/features/preview/lib/imageDisplay"

// What the zoom hands the picture it wraps: its pointer and double-click handlers, and its fit and transform.
interface ZoomBinding {
	readonly className: string
	readonly style: CSSProperties
	readonly onDoubleClick: () => void
	readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
	readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
	readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
	readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
}

// Fit-to-screen via max-width/max-height (an <img> and a <canvas> alike keep their aspect), plus pointer-drag pan
// while zoomed, double-click zoom toggle, wheel-zoom-toward-cursor and the viewer's keys — all pure math lives in
// imageViewer.logic.ts, this hook only wires DOM events to it. No pan/zoom library. `natural`: the picture's own size
// once known. The container takes `containerRef`, the picture the binding.
function useZoom(natural: Size | null): { containerRef: RefObject<HTMLDivElement | null>; binding: ZoomBinding } {
	const [transform, setTransform] = useState<ZoomTransform>({ scale: 1, x: 0, y: 0 })
	const containerRef = useRef<HTMLDivElement | null>(null)
	// Pointerdown-time snapshot: the transform's own x/y right then, plus the pointer's own screen
	// position — every subsequent pointermove computes its delta against THIS, never the previous
	// pointermove's position, so per-event float drift can never accumulate.
	const dragOrigin = useRef<{ x: number; y: number; pointerX: number; pointerY: number } | null>(null)
	// The pointers down on the picture (`touch-none` hands every touch to us): a one-pointer drag pans, a second
	// pointer turns the press into a pinch, measured against its start as the drag is.
	const pointers = useRef(new Map<number, { x: number; y: number }>())
	const pinch = useRef<{ distance: number; mid: { x: number; y: number }; transform: ZoomTransform } | null>(null)

	// A React onWheel prop can never preventDefault a page scroll here: react-dom registers the wheel
	// listener PASSIVE at its root for scroll performance (verified against the installed react-dom
	// build), so preventDefault silently no-ops inside a synthetic handler. A real, non-passive native
	// listener is the only way to stop the page scrolling under the zoom.
	useEffect(() => {
		const container = containerRef.current

		if (!container) {
			return
		}

		const handleWheel = (event: WheelEvent): void => {
			event.preventDefault()

			const rect = containerRef.current?.getBoundingClientRect()

			if (!rect) {
				return
			}

			const pointerOffset = { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }
			const containerSize: Size = { width: rect.width, height: rect.height }

			setTransform(prev => wheelZoom(prev, event.deltaY, pointerOffset, containerSize, natural))
		}

		container.addEventListener("wheel", handleWheel, { passive: false })

		return () => {
			container.removeEventListener("wheel", handleWheel)
		}
	}, [natural])

	const bindings = useBindings()
	const keyGroup = use(ImageKeyGroupContext)
	const zoomed = transform.scale > 1
	const onViewerKey = useLatestRef((event: KeyboardEvent): void => {
		const container = containerRef.current

		if (
			container === null ||
			// Another viewer beside it on screen takes the keys (a spread's other page).
			(keyGroup !== null && !keyGroup.owns(container)) ||
			event.defaultPrevented ||
			isImeKeydown(event) ||
			isRecordingCombo() ||
			!keyForEditor(container, event.target)
		) {
			return
		}

		const action = imageViewerKey(event, bindings, zoomed)

		if (action === undefined) {
			return
		}

		// Kept from the browser (its page zoom) and from the pager under it, even at a zoom limit.
		event.preventDefault()

		const rect = container.getBoundingClientRect()

		setTransform(prev => imageKeyTransform(action, prev, { width: rect.width, height: rect.height }, natural))
	})

	// The viewer's keys for its layer (the preview overlay, which keeps focus while an image shows), ahead of the
	// overlay's own pager: captured at the document, before the overlay's handler sees the arrows.
	useEffect(() => {
		const listener = (event: KeyboardEvent): void => {
			onViewerKey.current(event)
		}

		document.addEventListener("keydown", listener, true)

		return () => {
			document.removeEventListener("keydown", listener, true)
		}
	}, [onViewerKey])

	// The two pointers' spread and midpoint (relative to the container's center); null unless exactly two are down.
	function pinchOf(rect: DOMRect): { distance: number; mid: { x: number; y: number } } | null {
		if (pointers.current.size !== 2) {
			return null
		}

		const [a, b] = [...pointers.current.values()]

		if (a === undefined || b === undefined) {
			return null
		}

		return {
			distance: Math.hypot(a.x - b.x, a.y - b.y),
			mid: { x: (a.x + b.x) / 2 - rect.left - rect.width / 2, y: (a.y + b.y) / 2 - rect.top - rect.height / 2 }
		}
	}

	function handlePointerDown(event: ReactPointerEvent<HTMLElement>): void {
		const container = containerRef.current

		if (container === null || (event.pointerType === "mouse" && event.button !== 0)) {
			return
		}

		pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
		event.currentTarget.setPointerCapture(event.pointerId)

		if (pointers.current.size === 2) {
			// A second finger: the drag ends and the press becomes a pinch.
			dragOrigin.current = null

			const started = pinchOf(container.getBoundingClientRect())

			pinch.current = started === null ? null : { ...started, transform }

			return
		}

		if (pointers.current.size !== 1 || transform.scale <= 1) {
			return
		}

		dragOrigin.current = { x: transform.x, y: transform.y, pointerX: event.clientX, pointerY: event.clientY }
	}

	function handlePointerMove(event: ReactPointerEvent<HTMLElement>): void {
		const container = containerRef.current

		if (container === null || !pointers.current.has(event.pointerId)) {
			return
		}

		pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })

		const rect = container.getBoundingClientRect()
		const size: Size = { width: rect.width, height: rect.height }
		const start = pinch.current

		if (start !== null) {
			const now = pinchOf(rect)

			if (now !== null) {
				setTransform(pinchZoom(start.transform, start.distance, start.mid, now.distance, now.mid, size, natural))
			}

			return
		}

		const origin = dragOrigin.current

		if (origin === null || pointers.current.size !== 1) {
			return
		}

		const delta = { x: event.clientX - origin.pointerX, y: event.clientY - origin.pointerY }

		setTransform(prev => ({
			...prev,
			...dragPan({ x: origin.x, y: origin.y }, delta, prev.scale, size, natural)
		}))
	}

	function handlePointerUp(event: ReactPointerEvent<HTMLElement>): void {
		if (event.currentTarget.hasPointerCapture(event.pointerId)) {
			event.currentTarget.releasePointerCapture(event.pointerId)
		}

		pointers.current.delete(event.pointerId)
		dragOrigin.current = null

		// A pinch ends with its first lifted finger (the one left pans only once pressed again); two fingers left
		// of three pinch on from where they are.
		const container = containerRef.current
		const resumed = container === null ? null : pinchOf(container.getBoundingClientRect())

		pinch.current = resumed === null ? null : { ...resumed, transform }
	}

	return {
		containerRef,
		binding: {
			className: `max-h-full max-w-full touch-none object-contain select-none ${transform.scale > 1 ? "cursor-grab active:cursor-grabbing" : ""}`,
			style: { transform: `translate(${String(transform.x)}px, ${String(transform.y)}px) scale(${String(transform.scale)})` },
			onDoubleClick: () => {
				setTransform(prev => doubleClickZoom(prev))
			},
			onPointerDown: handlePointerDown,
			onPointerMove: handlePointerMove,
			onPointerUp: handlePointerUp,
			onPointerCancel: handlePointerUp
		}
	}
}

const CONTAINER_CLASS = "flex size-full items-center justify-center overflow-hidden"

// <img> from an already-resolved URL (streamed, blob or thumbnail): identical rendering whether `url` is a blob: URL
// or the SW's inline-preview route.
export function ZoomableImage({
	url,
	alt,
	onError,
	imageRef
}: {
	url: string
	alt: string
	// Takes the <img> that failed. Unset on a blob URL with nowhere further to fall back to (see RenderPreviewUrl).
	onError?: ((image: HTMLImageElement) => void) | undefined
	imageRef?: RefObject<HTMLImageElement | null> | undefined
}) {
	const [natural, setNatural] = useState<Size | null>(null)
	const [image, setImage] = useState<HTMLImageElement | null>(null)
	const shown = use(ImageShownContext)

	// Stepping past a streamed image before it has loaded stops its download.
	useReleaseOnUnmount(image)

	const { containerRef, binding } = useZoom(natural)

	return (
		<div
			ref={containerRef}
			className={CONTAINER_CLASS}
		>
			<img
				ref={element => {
					setImage(element)

					if (imageRef !== undefined) {
						imageRef.current = element
					}
				}}
				src={url}
				alt={alt}
				draggable={false}
				onError={
					onError === undefined
						? undefined
						: event => {
								onError(event.currentTarget)
							}
				}
				onLoad={event => {
					const size = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }

					setNatural(size)
					shown?.(size)
				}}
				{...binding}
			/>
		</div>
	)
}

// A Blob already in hand (a RAW's embedded preview, an inflated SVG).
export function BlobImage({ blob, alt }: { blob: Blob; alt: string }) {
	const url = useObjectUrl(blob)

	if (!url) {
		return null
	}

	return (
		<ZoomableImage
			url={url}
			alt={alt}
		/>
	)
}

// A decoded bitmap (our own decoders' output), drawn by a `bitmaprenderer` canvas that takes it over without a copy.
// `width`×`height` is the bitmap's size, read before it is handed over (a bitmap given to a canvas reads 0×0). The
// bitmap is the canvas's from then on; one never drawn is closed on unmount.
export function BitmapImage({ bitmap, width, height, alt }: { bitmap: ImageBitmap; width: number; height: number; alt: string }) {
	useEffect(
		() => () => {
			bitmap.close()
		},
		[bitmap]
	)

	const { containerRef, binding } = useZoom({ width, height })
	const shown = use(ImageShownContext)

	return (
		<div
			ref={containerRef}
			className={CONTAINER_CLASS}
		>
			<canvas
				ref={canvas => {
					// Already drawn (a ref attached again): the bitmap is the canvas's and reads 0×0.
					if (canvas === null || bitmap.width === 0) {
						return
					}

					canvas.getContext("bitmaprenderer")?.transferFromImageBitmap(bitmap)
					shown?.({ width, height })
				}}
				width={width}
				height={height}
				role="img"
				aria-label={alt}
				{...binding}
			/>
		</div>
	)
}

// A canvas its owner keeps drawing (an animation's frames), `width`×`height` in size, zoomed like the others.
export function ZoomableCanvas({
	width,
	height,
	alt,
	canvasRef
}: {
	width: number
	height: number
	alt: string
	canvasRef: (canvas: HTMLCanvasElement | null) => void
}) {
	const { containerRef, binding } = useZoom({ width, height })
	const shown = use(ImageShownContext)

	return (
		<div
			ref={containerRef}
			className={CONTAINER_CLASS}
		>
			<canvas
				ref={canvas => {
					canvasRef(canvas)

					if (canvas !== null) {
						shown?.({ width, height })
					}
				}}
				width={width}
				height={height}
				role="img"
				aria-label={alt}
				{...binding}
			/>
		</div>
	)
}
