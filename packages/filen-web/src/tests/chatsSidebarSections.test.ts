// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { act, renderHook } from "@testing-library/react"

// The conversation list's collapsed sections: kept on this device in the kv store (never localStorage) and read at
// boot, so the list's first render lays the sections out as the user left them.

const { stored, kvSetJson } = vi.hoisted(() => ({
	stored: new Map<string, unknown>([["chats.collapsedSections.v1", { direct: false, groups: true }]]),
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

const { loadCollapsedChatSections, toggleChatSection, useCollapsedChatSections } = await import("@/features/chats/lib/sidebarSections")

describe("collapsed chat sections", () => {
	it("starts expanded, reads the stored value at boot and stores each toggle", async () => {
		const { result } = renderHook(() => useCollapsedChatSections())

		expect(result.current).toEqual({ direct: false, groups: false })

		await act(() => loadCollapsedChatSections())

		expect(result.current).toEqual({ direct: false, groups: true })

		act(() => {
			toggleChatSection("direct")
		})

		expect(result.current).toEqual({ direct: true, groups: true })
		expect(kvSetJson).toHaveBeenLastCalledWith("chats.collapsedSections.v1", { direct: true, groups: true })
	})
})
