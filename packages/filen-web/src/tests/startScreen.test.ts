import { beforeEach, describe, expect, it, vi } from "vitest"

// Same mock boundary/shape as sidebarWidth.test.ts.
const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	}
}))

import { DEFAULT_START_SCREEN, START_SCREENS, getStartScreen, setStartScreen } from "@/features/shell/lib/startScreen"

beforeEach(() => {
	kvStore.clear()
})

describe("start screen: get/set", () => {
	it("returns the default (drive) when nothing is persisted", async () => {
		await expect(getStartScreen()).resolves.toBe(DEFAULT_START_SCREEN)
	})

	it("roundtrips every valid start screen through set/get", async () => {
		for (const screen of START_SCREENS) {
			await setStartScreen(screen)

			await expect(getStartScreen()).resolves.toBe(screen)
		}
	})
})
