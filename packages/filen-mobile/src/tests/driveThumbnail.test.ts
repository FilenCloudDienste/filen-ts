// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"
import { createElement } from "react"
import { render, waitFor, act } from "@testing-library/react"

const { mockGenerate, mockCanGenerate, mockHasThumbnail, mockIsUnavailable, mockInvalidateFile, appStateListeners } = vi.hoisted(() => ({
	mockGenerate: vi.fn(),
	mockCanGenerate: vi.fn(() => true),
	mockHasThumbnail: vi.fn(() => false),
	mockIsUnavailable: vi.fn(() => false),
	mockInvalidateFile: vi.fn(),
	appStateListeners: new Set<(state: string) => void>()
}))

// The shared react-native mock discards AppState handlers; capture them so the AppState-active
// re-entry point can be fired for real.
vi.mock("react-native", async () => {
	const actual = await import("@/tests/mocks/reactNative")

	return {
		...actual,
		AppState: {
			currentState: "active",
			addEventListener: (_type: string, handler: (state: string) => void) => {
				appStateListeners.add(handler)

				return {
					remove: () => {
						appStateListeners.delete(handler)
					}
				}
			}
		}
	}
})

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

vi.mock("@/lib/logger", async () => await import("@/tests/mocks/logger"))

vi.mock("@/lib/thumbnails", () => ({
	default: {
		generate: mockGenerate,
		canGenerate: mockCanGenerate,
		hasThumbnail: mockHasThumbnail,
		isUnavailable: mockIsUnavailable,
		invalidateFile: mockInvalidateFile
	},
	DIRECTORY: { uri: "file:///shared/group.io.filen.app/thumbnails/v4" }
}))

vi.mock("@filen/sdk-rs", () => ({
	DirColor: { Default: { new: () => ({ tag: "Default" }) } }
}))

// Real state so the null → FileIcon / string → Image transitions are observable.
vi.mock("@shopify/flash-list", async () => {
	const { useState } = await import("react")

	return {
		useRecyclingState: (init: unknown) => useState(typeof init === "function" ? (init as () => unknown)() : init)
	}
})

vi.mock("expo-router", async () => {
	const { useEffect } = await import("react")

	return {
		useFocusEffect: (effect: () => void | (() => void)) => {
			useEffect(effect, [effect])
		}
	}
})

vi.mock("@/stores/useHttp.store", () => ({
	default: {
		subscribe: vi.fn(() => () => {})
	}
}))

vi.mock("@/components/ui/image", async () => {
	const { createElement: h } = await import("react")

	return {
		default: (props: { source: { uri: string } }) => h("img", { "data-testid": "thumbnail-image", src: props.source.uri })
	}
})

vi.mock("@/components/itemIcons", async () => {
	const { createElement: h } = await import("react")

	return {
		FileIcon: (props: { name: string }) => h("div", { "data-testid": "file-icon", "data-name": props.name }),
		DirectoryIcon: () => h("div", { "data-testid": "directory-icon" })
	}
})

import Thumbnail from "@/features/drive/components/item/thumbnail"

const item = {
	type: "file" as const,
	data: {
		uuid: "raw-uuid",
		size: 1024n,
		canMakeThumbnail: true,
		undecryptable: false,
		decryptedMeta: { name: "shot.cr2" }
	}
} as never

function renderThumbnail() {
	return render(createElement(Thumbnail, { item, size: { icon: 38, thumbnail: 38 } }))
}

async function flushRetryWindow(): Promise<void> {
	// The retry loop sleeps 1s between attempts; a real 1.2s wait proves no second attempt fires.
	await new Promise(resolve => setTimeout(resolve, 1200))
}

async function fireAppStateActive(): Promise<void> {
	await act(async () => {
		for (const listener of appStateListeners) {
			listener("active")
		}

		await Promise.resolve()
	})
}

describe("drive Thumbnail — settled contract", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		appStateListeners.clear()
		mockCanGenerate.mockReturnValue(true)
		mockHasThumbnail.mockReturnValue(false)
		mockIsUnavailable.mockReturnValue(false)
	})

	it("renders the FileIcon without mounting the generator when the lib already settled the uuid", async () => {
		mockIsUnavailable.mockReturnValue(true)

		const { container } = renderThumbnail()

		await new Promise(resolve => setTimeout(resolve, 0))

		expect(mockGenerate).not.toHaveBeenCalled()
		expect(container.querySelector("[data-testid='file-icon']")).not.toBeNull()
	})

	it("renders the FileIcon and runs no retry iteration once generate() resolves null", async () => {
		mockGenerate.mockResolvedValue(null)

		const { container } = renderThumbnail()

		await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(1))
		await flushRetryWindow()

		expect(mockGenerate).toHaveBeenCalledTimes(1)
		expect(container.querySelector("[data-testid='file-icon']")).not.toBeNull()
		expect(container.querySelector("[data-testid='thumbnail-image']")).toBeNull()
		expect(mockInvalidateFile).not.toHaveBeenCalled()
	}, 5000)

	it("does not re-enter generate() on AppState active while the lib still says unavailable, but DOES once the online flip cleared it", async () => {
		mockGenerate.mockResolvedValue(null)

		const { container } = renderThumbnail()

		await waitFor(() => expect(mockGenerate).toHaveBeenCalledTimes(1))

		// The lib settled the uuid (session verdict) — the bail list reads the Set synchronously.
		mockIsUnavailable.mockReturnValue(true)

		await fireAppStateActive()
		await new Promise(resolve => setTimeout(resolve, 0))

		expect(mockGenerate).toHaveBeenCalledTimes(1)

		// subscribeRecovery() cleared the session Set on reconnect — the next entry point regenerates.
		mockIsUnavailable.mockReturnValue(false)
		mockGenerate.mockResolvedValue("file:///shared/group.io.filen.app/thumbnails/v4/raw-uuid.webp")

		await fireAppStateActive()

		await waitFor(() => expect(container.querySelector("[data-testid='thumbnail-image']")).not.toBeNull())
		expect(mockGenerate).toHaveBeenCalledTimes(2)
	}, 5000)

	it("renders the Image when generate() resolves a path", async () => {
		mockGenerate.mockResolvedValue("file:///shared/group.io.filen.app/thumbnails/v4/raw-uuid.webp")

		const { container } = renderThumbnail()

		await waitFor(() => expect(container.querySelector("[data-testid='thumbnail-image']")).not.toBeNull())

		expect(container.querySelector("[data-testid='thumbnail-image']")?.getAttribute("src")).toBe(
			"file:///shared/group.io.filen.app/thumbnails/v4/raw-uuid.webp"
		)
		expect(mockGenerate).toHaveBeenCalledTimes(1)
	})

	it("still retries a thrown (transient) error", async () => {
		mockGenerate
			.mockRejectedValueOnce(new Error("network"))
			.mockResolvedValue("file:///shared/group.io.filen.app/thumbnails/v4/raw-uuid.webp")

		const { container } = renderThumbnail()

		await waitFor(() => expect(container.querySelector("[data-testid='thumbnail-image']")).not.toBeNull(), { timeout: 3000 })

		expect(mockGenerate).toHaveBeenCalledTimes(2)
	}, 5000)
})
