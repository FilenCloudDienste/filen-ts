// @vitest-environment jsdom

// The assistant panel's width cap: a width saved on a wide window must not leave the resize handle
// working from a number larger than the panel on a narrower one.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import "@/lib/i18n"

const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	},
	kvEntriesJson: (prefix: string) => Promise.resolve([...kvStore].filter(([key]) => key.startsWith(prefix))),
	kvKeys: (prefix: string) => Promise.resolve([...kvStore.keys()].filter(key => key.startsWith(prefix))),
	kvHas: (key: string) => Promise.resolve(kvStore.has(key)),
	kvDelete: (key: string) => {
		kvStore.delete(key)

		return Promise.resolve()
	},
	kvDeletePrefix: (prefix: string) => {
		for (const key of [...kvStore.keys()].filter(key => key.startsWith(prefix))) {
			kvStore.delete(key)
		}

		return Promise.resolve()
	}
}))

vi.mock("@/lib/sdk/session", () => ({ hasPersistedSession: () => Promise.resolve(true), onAuthBroadcast: () => () => undefined }))

// Saved at the maximum on a wide window.
vi.mock("@/features/shell/queries/sidebarWidth", () => ({
	useSidebarWidthQuery: () => ({ data: 520, refetch: () => Promise.resolve() })
}))

import { AssistantSidePanel } from "@/features/assistant/components/assistantPanel"
import { registerAssistantSession } from "@/features/assistant/store/assistantSession"
import { createMockAssistantSession, MOCK_ASSISTANT_MODEL } from "@/features/assistant/store/mockAssistantSession"
import { SIDEBAR_WIDTH_STEP } from "@/features/shell/lib/sidebarWidth"

const WIDTH_KV_KEY = "shell.sidebarWidth.assistant.v1"

let unregister: () => void = () => undefined

function setViewportWidth(width: number): void {
	Object.defineProperty(window, "innerWidth", { configurable: true, value: width })
}

function panel(): HTMLElement {
	return screen.getByRole("complementary")
}

function separator(): HTMLElement {
	return screen.getByRole("separator")
}

beforeEach(() => {
	kvStore.clear()
	Element.prototype.setPointerCapture = vi.fn()
	Element.prototype.releasePointerCapture = vi.fn()
	unregister = registerAssistantSession(
		createMockAssistantSession({ initialState: { kind: "not-downloaded", model: MOCK_ASSISTANT_MODEL } })
	)
})

afterEach(() => {
	unregister()
	cleanup()
})

describe("AssistantSidePanel width cap", () => {
	it("renders and reports the width capped to 40% of the viewport", () => {
		setViewportWidth(1024)
		render(<AssistantSidePanel />)

		expect(panel().style.width).toBe("409px")
		expect(separator().getAttribute("aria-valuenow")).toBe("409")
	})

	it("uses the saved width once the viewport has room for it", () => {
		setViewportWidth(1024)
		render(<AssistantSidePanel />)

		act(() => {
			setViewportWidth(1600)
			window.dispatchEvent(new Event("resize"))
		})

		expect(panel().style.width).toBe("520px")
		expect(separator().getAttribute("aria-valuenow")).toBe("520")
	})

	it("shrinks on the first key press from the visible width", async () => {
		setViewportWidth(1024)
		render(<AssistantSidePanel />)

		fireEvent.keyDown(separator(), { key: "ArrowRight" })
		fireEvent.keyUp(separator(), { key: "ArrowRight" })

		expect(panel().style.width).toBe(`${String(409 - SIDEBAR_WIDTH_STEP)}px`)

		await waitFor(() => {
			expect(kvStore.get(WIDTH_KV_KEY)).toBe(409 - SIDEBAR_WIDTH_STEP)
		})
	})

	it("follows a drag from the visible width in both directions, never past the cap", async () => {
		setViewportWidth(1024)
		render(<AssistantSidePanel />)

		fireEvent.pointerDown(separator(), { pointerId: 1, clientX: 500 })
		fireEvent.pointerMove(separator(), { pointerId: 1, clientX: 530 })

		expect(panel().style.width).toBe("379px")

		fireEvent.pointerMove(separator(), { pointerId: 1, clientX: 400 })

		expect(panel().style.width).toBe("409px")

		fireEvent.pointerMove(separator(), { pointerId: 1, clientX: 520 })
		fireEvent.pointerUp(separator(), { pointerId: 1, clientX: 520 })

		await waitFor(() => {
			expect(kvStore.get(WIDTH_KV_KEY)).toBe(389)
		})
	})
})
