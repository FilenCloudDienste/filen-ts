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

vi.mock("@/components/drivePreview/previewSvg", () => ({ default: () => null }))
vi.mock("@/components/drivePreview/previewVideo", () => ({ default: () => null }))
vi.mock("@/components/drivePreview/previewAudio", () => ({ default: () => null }))
vi.mock("@/components/drivePreview/previewText", () => ({ default: () => null }))
vi.mock("@/components/drivePreview/previewPdf", () => ({ default: () => null }))
vi.mock("@/components/drivePreview/previewDocx", () => ({ default: () => null }))

import GalleryItem from "@/components/drivePreview/galleryItem"

function driveItem(name: string, uuid = "raw-uuid") {
	return {
		type: "drive" as const,
		data: {
			type: "file" as const,
			data: {
				uuid,
				size: 1n,
				canMakeThumbnail: true,
				undecryptable: false,
				decryptedMeta: { name }
			}
		}
	}
}

function renderItem(name: string, index = 0) {
	return render(
		createElement(GalleryItem, {
			info: { item: driveItem(name), index, target: "Cell", extraData: undefined } as never,
			galleryZoomScale: { value: 1 } as never,
			goBack: vi.fn()
		})
	)
}

describe("GalleryItem — rawImage", () => {
	beforeEach(() => {
		mockUseFileUrlQuery.mockReset().mockReturnValue({ status: "pending", data: undefined })
	})

	it("disables the file-url query and mounts PreviewRawImage inside PreviewSlot for the active page", () => {
		const { container } = renderItem("shot.cr2")

		expect(mockUseFileUrlQuery).toHaveBeenCalledWith(expect.objectContaining({ type: "drive" }), { enabled: false })

		const raw = container.querySelector("[data-testid='preview-raw-image']")

		expect(raw?.getAttribute("data-uuid")).toBe("raw-uuid")
		expect(raw?.getAttribute("data-active")).toBe("true")
		expect(container.querySelector("[data-testid='slot']")?.getAttribute("data-active")).toBe("true")
	})

	it("keeps a neighbouring RAW page inert (PreviewSlot inactive)", () => {
		const { container } = renderItem("shot.cr2", 1)

		expect(container.querySelector("[data-testid='slot']")?.getAttribute("data-active")).toBe("false")
	})

	it("keeps the file-url query enabled for an ordinary image and renders PreviewImage", () => {
		mockUseFileUrlQuery.mockReturnValue({ status: "success", data: "file:///cache/photo.jpg" })

		const { container } = renderItem("photo.jpg")

		expect(mockUseFileUrlQuery).toHaveBeenCalledWith(expect.objectContaining({ type: "drive" }), { enabled: true })
		expect(container.querySelector("img[data-testid='preview-image']")?.getAttribute("src")).toBe("file:///cache/photo.jpg")
		expect(container.querySelector("[data-testid='preview-raw-image']")).toBeNull()
	})

	it("renders the shared offline notice for an ordinary image the resolver could not serve", () => {
		mockUseFileUrlQuery.mockReturnValue({ status: "success", data: null })

		const { container } = renderItem("photo.jpg")

		expect(container.querySelector("[data-testid='offline-notice']")).not.toBeNull()
	})

	it("never shows the offline notice for RAW from the disabled file-url query", () => {
		mockUseFileUrlQuery.mockReturnValue({ status: "success", data: null })

		const { container } = renderItem("shot.cr2")

		expect(container.querySelector("[data-testid='offline-notice']")).toBeNull()
		expect(container.querySelector("[data-testid='preview-raw-image']")).not.toBeNull()
	})
})
