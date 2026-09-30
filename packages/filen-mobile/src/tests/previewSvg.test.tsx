// @vitest-environment happy-dom
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest"
import { cleanup, render } from "@testing-library/react"
import type { ReactNode } from "react"

const h = vi.hoisted(() => ({
	query: { status: "pending", data: undefined } as { status: string; data: string | undefined },
	parse: vi.fn()
}))

vi.mock("react-native", () => ({ useWindowDimensions: () => ({ width: 320, height: 640 }) }))
vi.mock("react-native-reanimated", () => ({}))
vi.mock("react-native-svg", () => ({
	parse: h.parse,
	SvgAst: ({ ast, override }: { ast: { id: string } | null; override?: object }) => (
		<div
			data-testid="svg"
			data-ast={ast?.id}
			data-override={JSON.stringify(override)}
		/>
	)
}))
vi.mock("@/components/ui/zoomableView", () => ({ default: ({ children }: { children?: ReactNode }) => <div>{children}</div> }))
vi.mock("@/components/drivePreview/previewLoadingOverlay", () => ({
	default: ({ status }: { status: string }) => <div data-testid={`overlay-${status}`} />
}))
vi.mock("@/queries/useFileText.query", () => ({ default: () => h.query }))
vi.mock("@/components/drivePreview/gallery", () => ({ galleryItemKey: () => "item" }))
vi.mock("@/components/drivePreview/galleryRenderName", () => ({ galleryItemFileSource: () => ({}) }))
vi.mock("@/components/drivePreview/unavailableOfflineNotice", () => ({ default: () => <div data-testid="offline" /> }))
vi.mock("@/components/drivePreview/previewAvailability", () => ({ isUnavailableOffline: () => false }))
vi.mock("@/hooks/useIsOnline", () => ({ default: () => true }))

import PreviewSvg from "@/components/drivePreview/previewSvg"
import type { GalleryItemTagged } from "@/components/drivePreview/gallery"
import type { SharedValue } from "react-native-reanimated"

function renderPreview() {
	return render(
		<PreviewSvg
			item={{} as GalleryItemTagged}
			zoomScale={{} as SharedValue<number>}
			onPinchDismiss={() => {}}
		/>
	)
}

function loaded(xml: string): void {
	h.query = { status: "success", data: xml }
}

beforeEach(() => {
	h.parse.mockReset()
	h.query = { status: "pending", data: undefined }
})

afterEach(() => {
	cleanup()
})

describe("PreviewSvg", () => {
	it("parses the document once and renders that AST at window size", () => {
		loaded("<svg/>")
		h.parse.mockReturnValue({ id: "root" })

		const { getByTestId } = renderPreview()
		const svg = getByTestId("svg")

		expect(h.parse).toHaveBeenCalledOnce()
		expect(h.parse).toHaveBeenCalledWith("<svg/>")
		expect(svg.getAttribute("data-ast")).toBe("root")
		expect(JSON.parse(svg.getAttribute("data-override") ?? "null")).toEqual({
			width: 320,
			height: 640,
			preserveAspectRatio: "xMidYMid meet"
		})
	})

	it("shows the error overlay when the document does not parse", () => {
		loaded("<svg")
		h.parse.mockImplementation(() => {
			throw new Error("malformed")
		})

		const { queryByTestId } = renderPreview()

		expect(queryByTestId("svg")).toBeNull()
		expect(queryByTestId("overlay-error")).not.toBeNull()
	})

	it("shows the error overlay for a document without an svg root", () => {
		loaded("<!-- empty -->")
		h.parse.mockReturnValue(null)

		const { queryByTestId } = renderPreview()

		expect(queryByTestId("svg")).toBeNull()
		expect(queryByTestId("overlay-error")).not.toBeNull()
	})

	it("refuses an oversized document without parsing it", () => {
		loaded("x".repeat(8 * 1024 * 1024 + 1))

		const { queryByTestId } = renderPreview()

		expect(h.parse).not.toHaveBeenCalled()
		expect(queryByTestId("overlay-error")).not.toBeNull()
	})

	it("shows the loading overlay until the document arrives", () => {
		const { queryByTestId } = renderPreview()

		expect(h.parse).not.toHaveBeenCalled()
		expect(queryByTestId("svg")).toBeNull()
		expect(queryByTestId("overlay-loading")).not.toBeNull()
	})
})
