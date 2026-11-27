// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { ImagePlaceholderContext } from "@/features/preview/lib/imageDisplay"
import { PreviewLoading } from "@/features/preview/components/previewErrorState"
import { ZoomableImage } from "@/features/preview/components/zoomableImage"

// A large image shows its grid thumbnail, blurred, while it loads: under the spinner, then behind the picture until
// the picture is in. Only a thumbnail already held is used.

afterEach(() => {
	cleanup()
})

function placeholders(container: HTMLElement): HTMLImageElement[] {
	return [...container.querySelectorAll<HTMLImageElement>("img[aria-hidden='true']")]
}

describe("image placeholder", () => {
	it("is a bare spinner without a held thumbnail", () => {
		const { container } = render(<PreviewLoading />)

		expect(screen.getByRole("status")).toBeTruthy()
		expect(placeholders(container)).toHaveLength(0)
	})

	it("blurs the held thumbnail under the spinner", () => {
		const { container } = render(
			<ImagePlaceholderContext value="blob:thumb">
				<PreviewLoading />
			</ImagePlaceholderContext>
		)

		expect(screen.getByRole("status")).toBeTruthy()
		expect(placeholders(container).map(image => image.getAttribute("src"))).toEqual(["blob:thumb"])
	})

	it("stays behind a streamed picture until it has loaded", () => {
		const { container } = render(
			<ImagePlaceholderContext value="blob:thumb">
				<ZoomableImage
					url="/stream/photo.jpg"
					alt="photo.jpg"
				/>
			</ImagePlaceholderContext>
		)

		expect(placeholders(container)).toHaveLength(1)

		fireEvent.load(screen.getByAltText("photo.jpg"))

		expect(placeholders(container)).toHaveLength(0)
	})
})
