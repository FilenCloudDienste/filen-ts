// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"
import { createElement } from "react"
import { render } from "@testing-library/react"

const { mockUseFileUrlQuery } = vi.hoisted(() => ({
	mockUseFileUrlQuery: vi.fn()
}))

vi.mock("react-native", async () => {
	const actual = await import("@/tests/mocks/reactNative")

	return {
		...actual,
		useWindowDimensions: () => ({ width: 400, height: 800, scale: 2, fontScale: 1 })
	}
})

vi.mock("@/components/drivePreview/previewStatus", async () => {
	const { createElement: h } = await import("react")

	return {
		PreviewSpinner: () => h("div", { "data-testid": "spinner" })
	}
})

vi.mock("@/constants", async () => await import("@/tests/mocks/constants"))

vi.mock("zustand/shallow", async () => await import("@/tests/mocks/zustandShallow"))

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

function renderItem(name: string, index = 0) {
	return render(
		createElement(GalleryItem, {
			info: {
				item: {
					type: "drive" as const,
					data: {
						type: "file" as const,
						data: { uuid: "file-uuid", size: 1n, canMakeThumbnail: true, undecryptable: false, decryptedMeta: { name } }
					}
				},
				index,
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

describe("GalleryItem — rawImage", () => {
	beforeEach(() => {
		mockUseFileUrlQuery.mockReset().mockReturnValue({ status: "pending", data: undefined })
	})

	it("disables the file-url query and mounts PreviewRawImage inside PreviewSlot for the active page", () => {
		const { container } = renderItem("shot.cr2")

		expect(mockUseFileUrlQuery).toHaveBeenCalledWith(expect.objectContaining({ type: "drive" }), { enabled: false })

		const raw = container.querySelector("[data-testid='preview-raw-image']")

		expect(raw?.getAttribute("data-uuid")).toBe("file-uuid")
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
