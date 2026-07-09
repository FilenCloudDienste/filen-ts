import type { Page } from "@playwright/test"

// Registers a console listener and returns the (initially empty, mutated in place) array of matched
// CSP-violation messages — callers assert `expect(cspViolations).toEqual([])` once the flow under
// test has finished.
export function trackCspViolations(page: Page): string[] {
	const cspViolations: string[] = []

	page.on("console", msg => {
		if (msg.type() === "error" && /content security policy|refused to/i.test(msg.text())) {
			cspViolations.push(msg.text())
		}
	})

	return cspViolations
}
