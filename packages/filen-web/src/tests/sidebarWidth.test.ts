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
	DEFAULT_ASSISTANT_WIDTH,
	DEFAULT_SIDEBAR_WIDTH,
	SIDEBAR_WIDTH_MIN,
	SIDEBAR_WIDTH_MAX,
	SIDEBAR_WIDTH_STEP,
	clampSidebarWidth,
	widthFromDrag,
	widthFromKey,
	widthFromLeadingDrag,
	widthFromLeadingKey,
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

describe("widthFromKey", () => {
	it("grows by one step on ArrowRight — the trailing-edge handle's own sign convention", () => {
		expect(widthFromKey("ArrowRight", 300)).toBe(300 + SIDEBAR_WIDTH_STEP)
	})

	it("shrinks by one step on ArrowLeft", () => {
		expect(widthFromKey("ArrowLeft", 300)).toBe(300 - SIDEBAR_WIDTH_STEP)
	})

	it("stays clamped at SIDEBAR_WIDTH_MIN when ArrowLeft would shrink past it", () => {
		expect(widthFromKey("ArrowLeft", SIDEBAR_WIDTH_MIN)).toBe(SIDEBAR_WIDTH_MIN)
	})

	it("stays clamped at SIDEBAR_WIDTH_MAX when ArrowRight would grow past it", () => {
		expect(widthFromKey("ArrowRight", SIDEBAR_WIDTH_MAX)).toBe(SIDEBAR_WIDTH_MAX)
	})

	it("jumps straight to the clamps on Home/End", () => {
		expect(widthFromKey("Home", 400)).toBe(SIDEBAR_WIDTH_MIN)
		expect(widthFromKey("End", 400)).toBe(SIDEBAR_WIDTH_MAX)
	})

	it("returns null for a key the separator does not handle, so the caller leaves the event alone", () => {
		expect(widthFromKey("a", 300)).toBeNull()
		expect(widthFromKey("ArrowUp", 300)).toBeNull()
	})
})

// The right-hand assistant panel's handle sits on its left edge, so both mappings mirror.
describe("widthFromLeadingDrag", () => {
	it("grows the width when the pointer moves left, away from the panel's fixed right edge", () => {
		expect(widthFromLeadingDrag(300, 500, 440)).toBe(360)
	})

	it("shrinks it when the pointer moves right", () => {
		expect(widthFromLeadingDrag(300, 500, 560)).toBe(240)
	})

	it("clamps to the same bounds as the trailing-edge math", () => {
		expect(widthFromLeadingDrag(300, 500, 2000)).toBe(SIDEBAR_WIDTH_MIN)
		expect(widthFromLeadingDrag(300, 500, -2000)).toBe(SIDEBAR_WIDTH_MAX)
	})
})

describe("widthFromLeadingKey", () => {
	it("grows on ArrowLeft and shrinks on ArrowRight, the way the edge moves", () => {
		expect(widthFromLeadingKey("ArrowLeft", 300)).toBe(300 + SIDEBAR_WIDTH_STEP)
		expect(widthFromLeadingKey("ArrowRight", 300)).toBe(300 - SIDEBAR_WIDTH_STEP)
	})

	it("keeps Home/End on the clamps and ignores other keys", () => {
		expect(widthFromLeadingKey("Home", 400)).toBe(SIDEBAR_WIDTH_MIN)
		expect(widthFromLeadingKey("End", 400)).toBe(SIDEBAR_WIDTH_MAX)
		expect(widthFromLeadingKey("ArrowUp", 400)).toBeNull()
	})
})

describe("sidebar width: get/set", () => {
	it("defaults the assistant panel wider than the list sidebars, under its own key", async () => {
		await expect(getSidebarWidth("assistant")).resolves.toBe(DEFAULT_ASSISTANT_WIDTH)

		await setSidebarWidth("assistant", 420)

		expect(kvStore.get("shell.sidebarWidth.assistant.v1")).toBe(420)
		await expect(getSidebarWidth("drive")).resolves.toBe(DEFAULT_SIDEBAR_WIDTH)
	})

	it("returns the default when nothing is persisted", async () => {
		await expect(getSidebarWidth("drive")).resolves.toBe(DEFAULT_SIDEBAR_WIDTH)
	})

	it("starts the Sync and Mounts lists at the narrowest width", async () => {
		await expect(getSidebarWidth("sync")).resolves.toBe(SIDEBAR_WIDTH_MIN)
		await expect(getSidebarWidth("mounts")).resolves.toBe(SIDEBAR_WIDTH_MIN)
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

	it("persists each module under its own key — one module's width never leaks into another", async () => {
		await setSidebarWidth("drive", 320)
		await setSidebarWidth("notes", 360)
		await setSidebarWidth("chats", 400)
		await setSidebarWidth("playlists", 440)

		await expect(getSidebarWidth("drive")).resolves.toBe(320)
		await expect(getSidebarWidth("notes")).resolves.toBe(360)
		await expect(getSidebarWidth("chats")).resolves.toBe(400)
		await expect(getSidebarWidth("playlists")).resolves.toBe(440)
	})
})
