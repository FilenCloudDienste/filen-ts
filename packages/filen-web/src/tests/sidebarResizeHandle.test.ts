// @vitest-environment jsdom

// Render cases for the sidebar separator's drag/keyboard commit interplay, same kv Map boundary as
// sidebarWidth.test.ts so the assertion is the real persisted width.
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react"
import { createElement } from "react"

const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	}
}))

// The hook only ever reads `data` and calls `refetch()` after a commit — no query client needed.
vi.mock("@/features/shell/queries/sidebarWidth", () => ({
	useSidebarWidthQuery: () => ({ data: 300, refetch: () => Promise.resolve() })
}))

const { SidebarResizeHandle } = await import("@/features/shell/components/sidebarResizeHandle")
const { useResizableSidebar } = await import("@/features/shell/hooks/useResizableSidebar")
const { SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_STEP } = await import("@/features/shell/lib/sidebarWidth")

const WIDTH_KV_KEY = "shell.sidebarWidth.drive.v1"

function Harness() {
	return createElement(SidebarResizeHandle, { ariaLabel: "Resize", handle: useResizableSidebar("drive") })
}

beforeEach(() => {
	kvStore.clear()
	// jsdom implements no pointer capture, which the separator takes on pointerdown.
	Element.prototype.setPointerCapture = vi.fn()
	Element.prototype.releasePointerCapture = vi.fn()

	cleanup()
	render(createElement(Harness))
})

function separator(): HTMLElement {
	return screen.getByRole("separator")
}

describe("SidebarResizeHandle", () => {
	it("persists the keyboard-adjusted width on key release", async () => {
		fireEvent.keyDown(separator(), { key: "ArrowRight" })
		fireEvent.keyUp(separator(), { key: "ArrowRight" })

		await waitFor(() => {
			expect(kvStore.get(WIDTH_KV_KEY)).toBe(300 + SIDEBAR_WIDTH_STEP)
		})
	})

	it("persists the dragged width on pointerup", async () => {
		fireEvent.pointerDown(separator(), { pointerId: 1, clientX: 100 })
		fireEvent.pointerMove(separator(), { pointerId: 1, clientX: 140 })
		fireEvent.pointerUp(separator(), { pointerId: 1, clientX: 140 })

		await waitFor(() => {
			expect(kvStore.get(WIDTH_KV_KEY)).toBe(340)
		})
	})

	// A cancelled drag fires no pointerup: it must still commit the dragged width and end the drag, or
	// every later keyboard commit is vetoed.
	it("commits a cancelled drag and still persists later keyboard adjustments", async () => {
		fireEvent.pointerDown(separator(), { pointerId: 1, clientX: 100 })
		fireEvent.pointerMove(separator(), { pointerId: 1, clientX: 120 })
		fireEvent.pointerCancel(separator(), { pointerId: 1 })

		await waitFor(() => {
			expect(kvStore.get(WIDTH_KV_KEY)).toBe(320)
		})

		fireEvent.keyDown(separator(), { key: "End" })
		fireEvent.keyUp(separator(), { key: "End" })

		await waitFor(() => {
			expect(kvStore.get(WIDTH_KV_KEY)).toBe(SIDEBAR_WIDTH_MAX)
		})
	})
})
