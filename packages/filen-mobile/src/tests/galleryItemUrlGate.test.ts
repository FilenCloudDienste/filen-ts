// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"
import { createElement } from "react"
import { render } from "@testing-library/react"

const { mockUseFileUrlQuery } = vi.hoisted(() => ({
	mockUseFileUrlQuery: vi.fn()
}))

vi.mock("react-native", async () => {
	const actual = await import("@/tests/mocks/reactNative")
	const { createElement: h } = await import("react")

	return {
		...actual,
		useWindowDimensions: () => ({ width: 400, height: 800, scale: 2, fontScale: 1 }),
		ActivityIndicator: () => h("div", { "data-testid": "spinner" })
	}
})

vi.mock("expo-file-system", async () => await import("@/tests/mocks/expoFileSystem"))

// galleryItem reaches the REAL previewType.ts, which reads EXPO_AUDIO_SUPPORTED_EXTENSIONS from
// @/constants (previewType.ts:5); the shared mock lacks it — spread it in rather than widening the
// shared file, so classification never depends on which branch evaluates first.
vi.mock("@/constants", async () => ({
	...(await import("@/tests/mocks/constants")),
	EXPO_AUDIO_SUPPORTED_EXTENSIONS: new Set([".mp3", ".m4a", ".wav"])
}))

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (k: string) => k })
}))

vi.mock("zustand/shallow", () => ({
	useShallow: (fn: unknown) => fn
}))

vi.mock("@/stores/useDrivePreview.store", () => ({
	default: (selector: (state: { currentIndex: number }) => unknown) => selector({ currentIndex: 0 })
}))

vi.mock("@/components/drivePreview/gallery", () => ({
	galleryItemKey: (item: { type: string; data: { data?: { uuid: string }; url?: string } }) =>
		item.type === "drive" ? (item.data.data?.uuid ?? "") : (item.data.url ?? "")
}))

vi.mock("@/queries/useFileUrl.query", () => ({
	default: mockUseFileUrlQuery
}))

vi.mock("@/components/ui/view", async () => {
	const { createElement: h } = await import("react")

	return {
		default: (props: { children?: unknown }) => h("div", null, props.children as never)
	}
})

vi.mock("@/components/drivePreview/unavailableOfflineNotice", async () => {
	const { createElement: h } = await import("react")

	return {
		default: () => h("div", { "data-testid": "offline-notice" }, "unavailable_offline")
	}
})

vi.mock("@/components/drivePreview/previewSlot", async () => {
	const { createElement: h } = await import("react")

	return {
		default: (props: { isActive: boolean; children?: unknown }) =>
			h("div", { "data-testid": "slot", "data-active": String(props.isActive) }, props.children as never)
	}
})

vi.mock("@/components/drivePreview/previewRawImage", async () => {
	const { createElement: h } = await import("react")

	return {
		default: (props: { isActive: boolean; item: { data: { uuid: string } } }) =>
			h("div", { "data-testid": "preview-raw-image", "data-active": String(props.isActive), "data-uuid": props.item.data.uuid })
	}
})

vi.mock("@/components/drivePreview/previewImage", async () => {
	const { createElement: h } = await import("react")

	return {
		default: (props: { fileUrl: string }) => h("img", { "data-testid": "preview-image", src: props.fileUrl })
	}
})

function marker(testId: string) {
	return async () => {
		const { createElement: h } = await import("react")

		return { default: () => h("div", { "data-testid": testId }) }
	}
}

vi.mock("@/components/drivePreview/previewSvg", marker("preview-svg"))
vi.mock("@/components/drivePreview/previewVideo", marker("preview-video"))
vi.mock("@/components/drivePreview/previewAudio", marker("preview-audio"))
vi.mock("@/components/drivePreview/previewText", marker("preview-text"))
vi.mock("@/components/drivePreview/previewPdf", marker("preview-pdf"))
vi.mock("@/components/drivePreview/previewDocx", marker("preview-docx"))

import GalleryItem from "@/components/drivePreview/galleryItem"
import { isUnavailableOffline } from "@/components/drivePreview/previewAvailability"

function renderItem(name: string) {
	return render(
		createElement(GalleryItem, {
			info: {
				item: {
					type: "drive" as const,
					data: {
						type: "file" as const,
						data: { uuid: "uuid", size: 1n, canMakeThumbnail: false, undecryptable: false, decryptedMeta: { name } }
					}
				},
				index: 0,
				target: "Cell",
				extraData: undefined
			} as never,
			galleryZoomScale: { value: 1 } as never,
			goBack: vi.fn()
		})
	)
}

describe("GalleryItem — URL resolution only for URL-rendered types", () => {
	beforeEach(() => {
		// A disabled query never fetches; an enabled one is still waiting on the HTTP provider.
		mockUseFileUrlQuery.mockReset().mockReturnValue({ status: "pending", fetchStatus: "idle", data: undefined })
	})

	it.each([
		["doc.pdf", "preview-pdf"],
		["doc.docx", "preview-docx"],
		["notes.txt", "preview-text"],
		["main.ts", "preview-text"],
		["icon.svg", "preview-svg"],
		["song.mp3", "preview-audio"]
	])("%s mounts its own preview at once, with no URL lookup", (name, testId) => {
		const { container } = renderItem(name)

		expect(mockUseFileUrlQuery).toHaveBeenCalledWith(expect.objectContaining({ type: "drive" }), { enabled: false })
		expect(container.querySelector(`[data-testid='${testId}']`)).not.toBeNull()
		expect(container.querySelector("[data-testid='spinner']")).toBeNull()
	})

	it.each(["photo.jpg", "clip.mp4"])("%s still waits for its URL", name => {
		const { container } = renderItem(name)

		expect(mockUseFileUrlQuery).toHaveBeenCalledWith(expect.objectContaining({ type: "drive" }), { enabled: true })
		expect(container.querySelector("[data-testid='spinner']")).not.toBeNull()
	})

	it("never shows the gallery's offline notice for a self-resolving type", () => {
		mockUseFileUrlQuery.mockReturnValue({ status: "success", fetchStatus: "idle", data: null })

		const { container } = renderItem("doc.pdf")

		expect(container.querySelector("[data-testid='offline-notice']")).toBeNull()
		expect(container.querySelector("[data-testid='preview-pdf']")).not.toBeNull()
	})
})

describe("isUnavailableOffline", () => {
	it("is a paused fetch, or a failed one while offline", () => {
		expect(isUnavailableOffline({ status: "pending", fetchStatus: "paused" }, true)).toBe(true)
		expect(isUnavailableOffline({ status: "error", fetchStatus: "idle" }, false)).toBe(true)
	})

	it("is not a failure while online, a load in progress, or a success", () => {
		expect(isUnavailableOffline({ status: "error", fetchStatus: "idle" }, true)).toBe(false)
		expect(isUnavailableOffline({ status: "pending", fetchStatus: "fetching" }, false)).toBe(false)
		expect(isUnavailableOffline({ status: "success", fetchStatus: "paused" }, false)).toBe(false)
	})
})
