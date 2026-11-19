import { createContext, useContext, useEffect, useState } from "react"

// The scroll container the elements below scroll in, when it is not the page: an IntersectionObserver against the
// viewport sees a target only once the container's own clip lets it through, so the margin would never apply.
// `null` while that container is not mounted yet (nothing is observed until it is); absent (undefined) for the viewport.
export const NearViewportRootContext = createContext<Element | null | undefined>(undefined)

// Whether `element` is within `margin` px of its scroll container (NearViewportRootContext, else `fallbackRoot`, else
// the viewport): one IntersectionObserver, reporting only as it crosses. Without IntersectionObserver every element
// counts as near.
export function useNearViewport(element: Element | null, margin: number, fallbackRoot?: Element): boolean {
	const contextRoot = useContext(NearViewportRootContext)
	const root = contextRoot === undefined ? fallbackRoot : contextRoot
	const [near, setNear] = useState(false)

	useEffect(() => {
		if (element === null || root === null || typeof IntersectionObserver === "undefined") {
			return undefined
		}

		const observer = new IntersectionObserver(
			entries => {
				const entry = entries.at(-1)

				if (entry !== undefined) {
					setNear(entry.isIntersecting)
				}
			},
			{ root: root ?? null, rootMargin: `${String(margin)}px 0px` }
		)

		observer.observe(element)

		return () => {
			observer.disconnect()
		}
	}, [element, root, margin])

	return element !== null && (near || typeof IntersectionObserver === "undefined")
}
