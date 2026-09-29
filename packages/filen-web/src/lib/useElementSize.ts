import { useEffect, useState } from "react"

export interface ElementSize {
	width: number
	height: number
}

const ZERO_SIZE: ElementSize = { width: 0, height: 0 }

// The element's content-box size, 0x0 until first observed. An observation that changes neither
// dimension keeps the previous object, so it does not re-render.
export function useElementSize(element: HTMLElement | null): ElementSize {
	const [size, setSize] = useState(ZERO_SIZE)

	useEffect(() => {
		if (!element) {
			return
		}

		const observer = new ResizeObserver(entries => {
			const entry = entries[0]

			if (!entry) {
				return
			}

			const { width, height } = entry.contentRect

			setSize(prev => (prev.width === width && prev.height === height ? prev : { width, height }))
		})

		observer.observe(element)

		return () => {
			observer.disconnect()
		}
	}, [element])

	return size
}
