// @vitest-environment jsdom

// Render cases for the split pane's separator, which the pure preference helpers
// (notesMdSplitPreferences.test.ts) cannot reach: the drag/keyboard commit interplay only exists in the
// component. The kv adapter is mocked with the same in-memory Map boundary that test uses, so the
// assertion is the real persisted ratio.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"

const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	}
}))

// The pane only ever reads `data` and calls `refetch()` after a commit — no query client needed.
vi.mock("@/features/notes/queries/preferences", () => ({
	useMdSplitRatioQuery: () => ({ data: 0.5, refetch: () => Promise.resolve() })
}))

const { MarkdownSplitPane } = await import("@/features/notes/components/markdownSplitPane")
const { MD_SPLIT_RATIO_STEP, MD_SPLIT_RATIO_MAX } = await import("@/features/notes/lib/preferences")

const RATIO_KV_KEY = "notes.mdSplitRatio.v1"

beforeEach(() => {
	kvStore.clear()
	// jsdom implements no pointer capture, which the separator takes on pointerdown.
	Element.prototype.setPointerCapture = vi.fn()
	Element.prototype.releasePointerCapture = vi.fn()

	cleanup()
	render(
		createElement(MarkdownSplitPane, {
			left: createElement("div"),
			right: createElement("div")
		})
	)
})

function separator(): HTMLElement {
	return screen.getByRole("separator")
}

describe("MarkdownSplitPane — keyboard resize", () => {
	it("persists the adjusted ratio on key release", async () => {
		fireEvent.keyDown(separator(), { key: "ArrowRight" })
		fireEvent.keyUp(separator(), { key: "ArrowRight" })

		await waitFor(() => {
			expect(kvStore.get(RATIO_KV_KEY)).toBeCloseTo(0.5 + MD_SPLIT_RATIO_STEP)
		})
	})

	// A cancelled drag (browser reclaiming a touch gesture, pen palm-rejection) fires no pointerup, so
	// without the pointercancel handler the drag flag stays set and vetoes every later keyboard commit.
	it("still persists after a drag ends in pointercancel", async () => {
		fireEvent.pointerDown(separator(), { pointerId: 1 })
		fireEvent.pointerCancel(separator(), { pointerId: 1 })

		fireEvent.keyDown(separator(), { key: "End" })
		fireEvent.keyUp(separator(), { key: "End" })

		await waitFor(() => {
			expect(kvStore.get(RATIO_KV_KEY)).toBe(MD_SPLIT_RATIO_MAX)
		})
	})
})
