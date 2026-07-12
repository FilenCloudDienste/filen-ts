import { beforeEach, describe, expect, it, vi } from "vitest"

// Same mock boundary/shape as notesMdSplitPreferences.test.ts: `@/lib/storage/adapter` itself, backed
// by an in-memory Map reset per test — kvGetJson/kvSetJson's own envelope+schema contract is already
// covered by adapter.test.ts.
const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	}
}))

import {
	DEFAULT_SIDEBAR_WIDTH,
	SIDEBAR_WIDTH_MIN,
	SIDEBAR_WIDTH_MAX,
	clampSidebarWidth,
	widthFromDrag,
	getSidebarWidth,
	setSidebarWidth
} from "@/features/shell/lib/sidebarWidth"

beforeEach(() => {
	kvStore.clear()
})

describe("clampSidebarWidth", () => {
	it("passes a value already inside the range through unchanged", () => {
		expect(clampSidebarWidth(320)).toBe(320)
	})

	it("clamps below SIDEBAR_WIDTH_MIN up to the floor", () => {
		expect(clampSidebarWidth(100)).toBe(SIDEBAR_WIDTH_MIN)
		expect(clampSidebarWidth(-50)).toBe(SIDEBAR_WIDTH_MIN)
	})

	it("clamps above SIDEBAR_WIDTH_MAX down to the ceiling", () => {
		expect(clampSidebarWidth(900)).toBe(SIDEBAR_WIDTH_MAX)
	})
})

describe("widthFromDrag", () => {
	it("adds the pointer's clientX delta to the width recorded at pointerdown", () => {
		expect(widthFromDrag(300, 500, 560)).toBe(360)
	})

	it("shrinks the width when the pointer moves left (negative delta)", () => {
		expect(widthFromDrag(300, 500, 440)).toBe(240)
	})

	it("is a no-op when clientX hasn't moved from the start", () => {
		expect(widthFromDrag(300, 500, 500)).toBe(300)
	})

	it("clamps the result to SIDEBAR_WIDTH_MIN when the drag would shrink past it", () => {
		expect(widthFromDrag(DEFAULT_SIDEBAR_WIDTH, 500, 100)).toBe(SIDEBAR_WIDTH_MIN)
	})

	it("clamps the result to SIDEBAR_WIDTH_MAX when the drag would grow past it", () => {
		expect(widthFromDrag(DEFAULT_SIDEBAR_WIDTH, 500, 2000)).toBe(SIDEBAR_WIDTH_MAX)
	})
})

describe("sidebar width: get/set", () => {
	it("returns the default when nothing is persisted", async () => {
		await expect(getSidebarWidth("drive")).resolves.toBe(DEFAULT_SIDEBAR_WIDTH)
	})

	it("roundtrips a stored in-range value through set/get", async () => {
		await setSidebarWidth("drive", 400)

		await expect(getSidebarWidth("drive")).resolves.toBe(400)
	})

	it("clamps an out-of-range value on the way in (set), not just on read", async () => {
		await setSidebarWidth("drive", 5000)

		await expect(getSidebarWidth("drive")).resolves.toBe(SIDEBAR_WIDTH_MAX)
	})

	it("clamps a persisted-but-out-of-range value on the way out (get) too", async () => {
		kvStore.set("shell.sidebarWidth.drive.v1", 5000)

		await expect(getSidebarWidth("drive")).resolves.toBe(SIDEBAR_WIDTH_MAX)
	})

	it("persists notes/chats/drive under independent keys — one module's width never leaks into another", async () => {
		await setSidebarWidth("drive", 320)
		await setSidebarWidth("notes", 360)
		await setSidebarWidth("chats", 400)

		await expect(getSidebarWidth("drive")).resolves.toBe(320)
		await expect(getSidebarWidth("notes")).resolves.toBe(360)
		await expect(getSidebarWidth("chats")).resolves.toBe(400)
	})
})
