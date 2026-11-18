import { useEffect, useState } from "react"

// Whether `element` is within `margin` px of the viewport: one IntersectionObserver, reporting only as it crosses.
// Without IntersectionObserver every element counts as near.
export function useNearViewport(element: Element | null, margin: number): boolean {
	const [near, setNear] = useState(false)

	useEffect(() => {
		if (element === null || typeof IntersectionObserver === "undefined") {
			return undefined
		}

		const observer = new IntersectionObserver(
			entries => {
				const entry = entries.at(-1)

				if (entry !== undefined) {
					setNear(entry.isIntersecting)
				}
			},
			{ rootMargin: `${String(margin)}px 0px` }
		)

		observer.observe(element)

		return () => {
			observer.disconnect()
		}
	}, [element, margin])

	return element !== null && (near || typeof IntersectionObserver === "undefined")
}
