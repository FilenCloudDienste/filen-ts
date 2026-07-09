import { useEffect, useRef, useState } from "react"

export interface ImageViewerProps {
	bytes: Uint8Array
	// Possibly-undefined VALUE, not an absent key (exactOptionalPropertyTypes) — the caller always
	// passes decryptedMeta?.mime through as-is, undefined included.
	mime: string | undefined
	alt: string
}

const MIN_SCALE = 0.25
const MAX_SCALE = 8
// Wheel delta -> scale factor; a typical mouse-wheel notch (~100 deltaY) nudges zoom by ~15%.
const ZOOM_SENSITIVITY = 0.0015

// <img> from a blob URL, minted/revoked entirely in this component's own effect so the blob never
// outlives it. Fit-to-screen via object-contain, plus a basic uniform wheel-zoom (no pan, no lib).
export function ImageViewer({ bytes, mime, alt }: ImageViewerProps) {
	const [url, setUrl] = useState<string | null>(null)
	const [scale, setScale] = useState(1)
	const containerRef = useRef<HTMLDivElement | null>(null)

	useEffect(() => {
		// The generic ArrayBufferLike-vs-ArrayBuffer parameter on Uint8Array (TS lib.es2024.arraybuffer)
		// makes an unparameterized Uint8Array reject BlobPart's stricter ArrayBufferView<ArrayBuffer> —
		// bytes here is always backed by a real ArrayBuffer (Comlink.transfer of a worker download, never
		// a SharedArrayBuffer), so this narrows the generic parameter only, not the value.
		const objectUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime ?? "application/octet-stream" }))

		// Minting the blob URL IS the side effect (a fresh external-system resource requiring a paired
		// revoke) — there is no value to render until this runs, so it cannot be computed during render. A
		// useMemo/lazy-useState alternative would recompute under StrictMode's double-invoke with no
		// cleanup hook to revoke the discarded first URL, leaking it; this effect's own cleanup below is
		// exactly what makes the double-invoke safe (create/revoke/create, no leak).
		// eslint-disable-next-line react-hooks/set-state-in-effect -- deliberate, see above
		setUrl(objectUrl)

		return () => {
			URL.revokeObjectURL(objectUrl)
		}
	}, [bytes, mime])

	// A React onWheel prop can never preventDefault a page scroll here: react-dom registers the wheel
	// listener PASSIVE at its root for scroll performance (verified against the installed react-dom
	// build), so preventDefault silently no-ops inside a synthetic handler. A real, non-passive native
	// listener is the only way to stop the page scrolling under the zoom.
	useEffect(() => {
		const container = containerRef.current

		if (!container) {
			return
		}

		function handleWheel(event: WheelEvent): void {
			event.preventDefault()
			setScale(prev => Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev - event.deltaY * ZOOM_SENSITIVITY)))
		}

		container.addEventListener("wheel", handleWheel, { passive: false })

		return () => {
			container.removeEventListener("wheel", handleWheel)
		}
	}, [])

	if (!url) {
		return null
	}

	return (
		<div
			ref={containerRef}
			className="flex size-full items-center justify-center overflow-hidden"
		>
			<img
				src={url}
				alt={alt}
				draggable={false}
				className="max-h-full max-w-full object-contain select-none"
				style={{ transform: `scale(${String(scale)})` }}
			/>
		</div>
	)
}
