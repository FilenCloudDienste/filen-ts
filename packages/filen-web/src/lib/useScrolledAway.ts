import { useEffect, useState } from "react"

// Whether `element` is scrolled entirely out of `root`'s view. One IntersectionObserver, no scroll
// listener: it only reports when the element crosses the edge.
export function useScrolledAway(element: Element | null, root: Element | null): boolean {
	const [away, setAway] = useState(false)

	useEffect(() => {
		if (element === null || root === null) {
			return undefined
		}

		const observer = new IntersectionObserver(
			entries => {
				const entry = entries.at(-1)

				if (entry !== undefined) {
					setAway(!entry.isIntersecting)
				}
			},
			{ root }
		)

		observer.observe(element)

		return () => {
			observer.disconnect()
		}
	}, [element, root])

	// A verdict about an element that is gone no longer holds; its replacement is observed afresh.
	return away && element !== null && root !== null
}
