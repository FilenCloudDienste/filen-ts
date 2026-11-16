import { beforeEach, describe, expect, it, vi } from "vitest"

// One fake observer for the module's single ResizeObserver; its callback replays a resize.
const observed: { callback: (entries: unknown[]) => void } = {
	callback: () => {
		throw new Error("no observer yet")
	}
}
// The elements the module observes, which the fake only records.
const watching = new Set<unknown>()

// Per test: vitest.config.ts sets `unstubGlobals`. The module builds its one observer on first use and keeps it.
class FakeResizeObserver {
	constructor(callback: (entries: unknown[]) => void) {
		observed.callback = callback
	}

	observe(target: unknown): void {
		watching.add(target)
	}

	unobserve(target: unknown): void {
		watching.delete(target)
	}

	disconnect(): void {
		watching.clear()
	}
}

const { contentRoomRef, contentRoomWidth } = await import("@/features/shell/lib/contentRoom")
const { isChatInfoNarrow, subscribeToChatInfoBreakpoint } = await import("@/features/chats/lib/chatInfoLayout")

function element(width: number): HTMLElement {
	return { getBoundingClientRect: () => ({ width }) } as unknown as HTMLElement
}

function resize(target: HTMLElement, width: number): void {
	observed.callback([{ target, borderBoxSize: [{ inlineSize: width }], contentRect: { width } }])
}

const detach: (() => void)[] = []

beforeEach(() => {
	vi.stubGlobal("ResizeObserver", FakeResizeObserver)

	for (const release of detach.splice(0)) {
		release()
	}
})

function attach(part: "main" | "slot", width: number): HTMLElement {
	const target = element(width)
	const release = contentRoomRef(part)(target)

	if (release !== undefined) {
		detach.push(release)
	}

	return target
}

describe("chat info layout", () => {
	it("is a sheet while nothing is measured (outside the shell)", () => {
		expect(contentRoomWidth()).toBe(0)
		expect(isChatInfoNarrow()).toBe(true)
	})

	it("goes inline only while the card keeps 560px beside the 320px panel and the gap", () => {
		const main = attach("main", 887)

		expect(isChatInfoNarrow()).toBe(true)

		resize(main, 888)

		expect(isChatInfoNarrow()).toBe(false)
	})

	it("counts the shown panel back in, so showing it never flips the answer", () => {
		const main = attach("main", 900)
		const slot = attach("slot", 0)

		expect(isChatInfoNarrow()).toBe(false)

		// The panel mounts in the slot and the card gives up its width.
		resize(slot, 320)
		resize(main, 572)

		expect(contentRoomWidth()).toBe(900)
		expect(isChatInfoNarrow()).toBe(false)
	})

	it("turns into the sheet when the assistant (or a wider sidebar) takes the card's room, telling listeners once", () => {
		const main = attach("main", 572)
		const slot = attach("slot", 320)
		const listener = vi.fn()
		const unsubscribe = subscribeToChatInfoBreakpoint(listener)

		resize(main, 560)
		expect(listener).not.toHaveBeenCalled()

		// The assistant opens: the card would keep 400px beside the panel.
		resize(main, 400)
		expect(isChatInfoNarrow()).toBe(true)
		expect(listener).toHaveBeenCalledTimes(1)

		// The panel leaves the slot and the card takes its room back: still the sheet, no second call.
		resize(slot, 0)
		resize(main, 728)
		expect(isChatInfoNarrow()).toBe(true)
		expect(listener).toHaveBeenCalledTimes(1)

		unsubscribe()
	})
})
