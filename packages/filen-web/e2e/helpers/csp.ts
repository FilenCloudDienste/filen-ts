import type { Page } from "@playwright/test"

export const CSP_VIOLATION_PATTERN = /content security policy|refused to/i

// arktype detects CSP by attempting `new Function` (@ark/util envHasCsp); under the app's
// no-unsafe-eval CSP that probe is blocked — the browser logs a violation (firefox surfaces it as a
// console error, chromium does not) and arktype falls back to interpreted validation. This is
// arktype's intended CSP support, benign and expected, so it is never a failure.
const ARKTYPE_CSP_PROBE = /unsafe-eval/i

// Registers a console listener and returns the (initially empty, mutated in place) array of matched
// CSP-violation messages — callers assert `expect(cspViolations).toEqual([])` once the flow under
// test has finished.
export function trackCspViolations(page: Page): string[] {
	const cspViolations: string[] = []

	page.on("console", msg => {
		if (msg.type() === "error" && CSP_VIOLATION_PATTERN.test(msg.text())) {
			cspViolations.push(msg.text())
		}
	})

	return cspViolations
}

// Every console error from here on except arktype's CSP probe, collected the same way.
export function trackConsoleErrors(page: Page): string[] {
	const consoleErrors: string[] = []

	page.on("console", msg => {
		if (msg.type() === "error" && !ARKTYPE_CSP_PROBE.test(msg.text())) {
			consoleErrors.push(msg.text())
		}
	})

	return consoleErrors
}
