// @vitest-environment jsdom

import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

const { readSignedInHint } = vi.hoisted(() => ({ readSignedInHint: vi.fn(() => false) }))

vi.mock("@/lib/signedInHint", () => ({ readSignedInHint }))

const INDEX_HTML = readFileSync("index.html", "utf8")

// The splash exactly as index.html ships it, so the module is exercised against the real markup.
function splashMarkup(): string {
	const match = /<div\s+id="boot-splash"[\s\S]*?<\/svg>\s*<div><div><\/div><\/div>\s*<\/div>/.exec(INDEX_HTML)

	if (match === null) {
		throw new Error("boot splash markup not found in index.html")
	}

	return match[0]
}

function pathData(source: string): string {
	const match = /\sd="([^"]+)"/.exec(source)

	if (match === null) {
		throw new Error("no path data")
	}

	return match[1] ?? ""
}

function splash(): HTMLElement | null {
	return document.getElementById("boot-splash")
}

function shownPercent(): string | null {
	return splash()?.getAttribute("aria-valuenow") ?? null
}

function fillTransform(): string {
	const fill = splash()?.lastElementChild?.firstElementChild

	return fill instanceof HTMLElement ? fill.style.transform : ""
}

function stubReducedMotion(reduced: boolean): void {
	vi.stubGlobal("matchMedia", (query: string) => ({ matches: reduced && query.includes("reduce") }))
}

// Fresh module state per test: the splash's progress and dismissal are module-level by design.
async function load(): Promise<typeof import("@/lib/bootSplash")> {
	vi.resetModules()

	return import("@/lib/bootSplash")
}

beforeEach(() => {
	document.body.innerHTML = `${splashMarkup()}<div id="root"></div>`
	readSignedInHint.mockReturnValue(false)
	stubReducedMotion(false)
})

afterEach(() => {
	vi.useRealTimers()
	document.body.innerHTML = ""
})

describe("boot splash markup", () => {
	it("inlines the same logo path as the Logo component", () => {
		const logo = readFileSync("src/features/shell/components/logo.tsx", "utf8")

		expect(pathData(splashMarkup())).toBe(pathData(logo))
	})

	it("is a labelled progressbar, never a 'Loading' status a page's own loader would collide with", () => {
		const node = splash()

		expect(node?.getAttribute("role")).toBe("progressbar")
		expect(node?.getAttribute("aria-label")).toBe("Loading Filen")
		expect(shownPercent()).toBe("8")
	})
})

describe("advanceBootSplash", () => {
	it("steps through the signed-out targets and never moves back", async () => {
		const { advanceBootSplash } = await load()

		advanceBootSplash("bundle")
		expect(shownPercent()).toBe("25")
		expect(fillTransform()).toBe("scaleX(0.25)")

		advanceBootSplash("storage")
		expect(shownPercent()).toBe("85")

		advanceBootSplash("engine")
		expect(shownPercent()).toBe("85")

		advanceBootSplash("session")
		expect(shownPercent()).toBe("90")
	})

	it("weights a signed-in boot toward the session restore", async () => {
		readSignedInHint.mockReturnValue(true)

		const { advanceBootSplash } = await load()

		advanceBootSplash("engine")
		expect(shownPercent()).toBe("55")

		advanceBootSplash("storage")
		expect(shownPercent()).toBe("75")
	})

	it("reads the hint once per page", async () => {
		const { advanceBootSplash } = await load()

		advanceBootSplash("bundle")
		advanceBootSplash("engine")
		advanceBootSplash("session")

		expect(readSignedInHint).toHaveBeenCalledTimes(1)
	})

	it("does nothing once dismissed", async () => {
		stubReducedMotion(true)

		const { advanceBootSplash, dismissBootSplash } = await load()
		const node = splash()

		dismissBootSplash()
		advanceBootSplash("engine")

		expect(node?.getAttribute("aria-valuenow")).toBe("100")
	})
})

describe("dismissBootSplash", () => {
	it("fills the bar, fades, then removes the node", async () => {
		vi.useFakeTimers()

		const { dismissBootSplash } = await load()

		dismissBootSplash()

		expect(shownPercent()).toBe("100")
		expect(fillTransform()).toBe("scaleX(1)")
		expect(splash()?.classList.contains("boot-splash-out")).toBe(true)

		vi.advanceTimersByTime(200)

		expect(splash()).toBeNull()
	})

	it("removes the node at once under reduced motion", async () => {
		const { dismissBootSplash } = await load()

		stubReducedMotion(true)
		dismissBootSplash()

		expect(splash()).toBeNull()
	})

	it("is idempotent", async () => {
		vi.useFakeTimers()

		const { dismissBootSplash } = await load()
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout")

		dismissBootSplash()
		dismissBootSplash()

		expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
	})

	it("is a no-op without the node", async () => {
		document.body.innerHTML = ""

		const { advanceBootSplash, dismissBootSplash } = await load()

		expect(() => {
			advanceBootSplash("engine")
			dismissBootSplash()
		}).not.toThrow()
	})
})

describe("useBootSplashShown", () => {
	it("tracks the splash until it is dismissed", async () => {
		const { dismissBootSplash, useBootSplashShown } = await load()
		const { result } = renderHook(() => useBootSplashShown())

		expect(result.current).toBe(true)

		act(() => {
			dismissBootSplash()
		})

		expect(result.current).toBe(false)
	})

	it("is false when the page has no splash", async () => {
		document.body.innerHTML = ""

		const { useBootSplashShown } = await load()
		const { result } = renderHook(() => useBootSplashShown())

		expect(result.current).toBe(false)
	})
})

describe("useDismissBootSplash", () => {
	it("dismisses on the first commit", async () => {
		stubReducedMotion(true)

		const { useDismissBootSplash } = await load()

		renderHook(() => {
			useDismissBootSplash()
		})

		expect(splash()).toBeNull()
	})
})
