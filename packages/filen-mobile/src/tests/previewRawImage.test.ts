// @vitest-environment happy-dom

import { vi, describe, it, expect, beforeEach } from "vitest"
import { createElement } from "react"
import { render, fireEvent } from "@testing-library/react"

const { mockUseRawPreviewQuery, mockRefetch } = vi.hoisted(() => ({
	mockUseRawPreviewQuery: vi.fn(),
	mockRefetch: vi.fn()
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

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (k: string) => k })
}))

vi.mock("@/queries/useRawPreview.query", () => ({
	default: mockUseRawPreviewQuery
}))

vi.mock("@/components/ui/view", async () => {
	const { createElement: h } = await import("react")

	return {
		default: (props: { children?: unknown }) => h("div", null, props.children as never)
	}
})

vi.mock("@/components/ui/listEmpty", async () => {
	const { createElement: h } = await import("react")

	return {
		default: (props: { icon: string; title: string; description?: string }) =>
			h("div", { "data-testid": "list-empty", "data-icon": props.icon }, `${props.title}|${props.description ?? ""}`)
	}
})

vi.mock("@/components/drivePreview/previewLoadFailedNotice", async () => {
	const { createElement: h } = await import("react")

	return {
		default: (props: { onRetry: () => void }) =>
			h("div", { "data-testid": "load-failed" }, h("button", { "data-testid": "retry", onClick: props.onRetry }, "retry"))
	}
})

vi.mock("@/components/drivePreview/previewImage", async () => {
	const { createElement: h } = await import("react")

	return {
		default: (props: { fileUrl: string }) => h("img", { "data-testid": "preview-image", src: props.fileUrl })
	}
})

vi.mock("@/components/drivePreview/unavailableOfflineNotice", async () => {
	const { createElement: h } = await import("react")

	return {
		default: () => h("div", { "data-testid": "offline-notice" }, "unavailable_offline")
	}
})

import PreviewRawImage from "@/components/drivePreview/previewRawImage"

const item = {
	type: "file" as const,
	data: {
		uuid: "raw-uuid",
		size: 1n,
		canMakeThumbnail: true,
		undecryptable: false,
		decryptedMeta: { name: "shot.cr2" }
	}
}

function renderRaw(isActive = true) {
	return render(
		createElement(PreviewRawImage, {
			item: item as never,
			isActive,
			zoomScale: { value: 1 } as never,
			onPinchDismiss: vi.fn()
		})
	)
}

describe("PreviewRawImage", () => {
	beforeEach(() => {
		mockRefetch.mockReset()
		mockUseRawPreviewQuery.mockReset().mockReturnValue({ status: "pending", data: undefined, refetch: mockRefetch })
	})

	it("asks the query by value with enabled = isActive", () => {
		renderRaw(false)

		expect(mockUseRawPreviewQuery).toHaveBeenCalledWith({ type: "drive", data: { uuid: "raw-uuid", item } }, { enabled: false })

		renderRaw(true)

		expect(mockUseRawPreviewQuery).toHaveBeenLastCalledWith(expect.objectContaining({ type: "drive" }), { enabled: true })
	})

	it("renders PreviewImage on uri", () => {
		mockUseRawPreviewQuery.mockReturnValue({
			status: "success",
			data: { kind: "uri", uri: "file:///cache/raw-uuid.jpg" },
			refetch: mockRefetch
		})

		const { container } = renderRaw()

		expect(container.querySelector("img[data-testid='preview-image']")?.getAttribute("src")).toBe("file:///cache/raw-uuid.jpg")
	})

	it("renders the existing empty-state (no_preview, no subtitle) on noPreview", () => {
		mockUseRawPreviewQuery.mockReturnValue({ status: "success", data: { kind: "noPreview" }, refetch: mockRefetch })

		const { container } = renderRaw()

		const empty = container.querySelector("[data-testid='list-empty']")

		expect(empty?.textContent).toBe("no_preview|")
		expect(empty?.getAttribute("data-icon")).toBe("eye-off-outline")
		expect(container.querySelector("img")).toBeNull()
	})

	it("renders the shared unavailable-offline notice on offline", () => {
		mockUseRawPreviewQuery.mockReturnValue({ status: "success", data: { kind: "offline" }, refetch: mockRefetch })

		const { container } = renderRaw()

		expect(container.querySelector("[data-testid='offline-notice']")).not.toBeNull()
	})

	it("renders the shared load-failed notice on a query error and its Retry refetches", () => {
		mockUseRawPreviewQuery.mockReturnValue({ status: "error", data: undefined, error: new Error("network"), refetch: mockRefetch })

		const { container } = renderRaw()

		expect(container.querySelector("[data-testid='load-failed']")).not.toBeNull()

		fireEvent.click(container.querySelector("[data-testid='retry']") as Element)

		expect(mockRefetch).toHaveBeenCalledTimes(1)
	})

	it("shows the spinner while pending", () => {
		const { container } = renderRaw()

		expect(container.querySelector("[data-testid='spinner']")).not.toBeNull()
	})
})
