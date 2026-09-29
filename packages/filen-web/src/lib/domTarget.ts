// Probed by shape, not with `instanceof Element`, so callers stay testable in the DOM-free node
// environment.
export function hasClosest(target: EventTarget | null): target is EventTarget & { closest: (selector: string) => Element | null } {
	return typeof target === "object" && target !== null && typeof (target as { closest?: unknown }).closest === "function"
}
