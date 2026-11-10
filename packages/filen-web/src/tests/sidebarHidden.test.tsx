// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react"
import "@/lib/i18n"

// The desktop sidebar app.toggleSidebar hides: kept on this device in the kv store (never localStorage), read at boot
// so the first render already has it, and shown again from the rail's "Open navigation" button, which then hands focus
// to the sidebar.

const { stored, kvSetJson } = vi.hoisted(() => ({
	stored: new Map<string, unknown>([["shell.sidebarHidden.v1", true]]),
	kvSetJson: vi.fn((key: string, value: unknown) => {
		stored.set(key, value)

		return Promise.resolve()
	})
}))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(stored.get(key) ?? null),
	kvSetJson,
	kvDelete: () => Promise.resolve()
}))

const { loadSidebarHidden, setSidebarHidden, useSidebarHidden } = await import("@/features/shell/lib/sidebarHidden")
const { SidebarRevealButton } = await import("@/features/shell/components/sidebarDrawer")
const { registerAllActions } = await import("@/lib/keymap/actions")

registerAllActions()

// jsdom lays nothing out; the pane cycle only moves focus into an area on screen. (Restored after each test.)
beforeEach(() => {
	vi.spyOn(Element.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 10, 10)] as unknown as DOMRectList)
})

afterEach(() => {
	cleanup()
})

describe("the hidden sidebar", () => {
	it("is read from the kv store before anything renders, the default shown until then", async () => {
		const before = renderHook(() => useSidebarHidden())

		expect(before.result.current).toBe(false)

		await act(() => loadSidebarHidden())

		expect(before.result.current).toBe(true)
		before.unmount()

		// A render after boot reads it on its first pass.
		const first: boolean[] = []

		renderHook(() => {
			first.push(useSidebarHidden())
		})

		expect(first[0]).toBe(true)
	})

	it("offers Open navigation with its key while hidden, and shows the sidebar from it, focus moving in", async () => {
		await act(() => loadSidebarHidden())
		render(
			<>
				<SidebarRevealButton />
				<div data-shell-pane="sidebar">
					<button type="button">First sidebar row</button>
				</div>
			</>
		)

		const reveal = screen.getByRole("button", { name: "Open navigation" })

		// The narrow layout keeps the drawer's own trigger.
		expect(reveal.className).toContain("max-md:hidden")

		fireEvent.click(reveal)

		expect(screen.queryByRole("button", { name: "Open navigation" })).toBeNull()
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "First sidebar row" }))
		expect(kvSetJson).toHaveBeenLastCalledWith("shell.sidebarHidden.v1", false)

		act(() => {
			setSidebarHidden(true)
		})

		expect(screen.getByRole("button", { name: "Open navigation" })).toBeDefined()
		expect(kvSetJson).toHaveBeenLastCalledWith("shell.sidebarHidden.v1", true)
	})
})
