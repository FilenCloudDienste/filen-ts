// The app's global reduced-motion rule is CSS, which a JS-driven animation or scroll `behavior` bypasses.
export function prefersReducedMotion(): boolean {
	return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
}
