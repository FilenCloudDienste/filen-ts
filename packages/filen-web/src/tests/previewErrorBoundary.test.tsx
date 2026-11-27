// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, render, screen } from "@testing-library/react"
import type { File } from "@filen/sdk-rs"

vi.mock("@/lib/log", () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }))

import "@/lib/i18n"
import { PreviewErrorBoundary } from "@/features/preview/components/previewErrorBoundary"
import { PreviewDownloadableProvider } from "@/features/preview/lib/accessMode"
import { narrowItem } from "@/features/drive/lib/item"
import { testUuid } from "@/tests/support/uuid"

function doc() {
	const file: File = {
		uuid: testUuid("doc"),
		stableUUID: undefined,
		parent: testUuid("parent"),
		size: 3n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name: "notes.md", mime: "text/markdown", modified: 0n, size: 3n, key: "k", version: 2 } }
	}

	return narrowItem(file)
}

const state = { throws: true }

function Viewer() {
	if (state.throws) {
		throw new Error("parse failed")
	}

	return <p>rendered</p>
}

afterEach(() => {
	cleanup()
	state.throws = true
})

describe("PreviewErrorBoundary", () => {
	it("shows the file's card with Download and Retry when a viewer throws, and renders again on Retry", () => {
		const onDownload = vi.fn()

		vi.spyOn(console, "error").mockImplementation(() => undefined)
		render(
			<PreviewDownloadableProvider
				downloadable
				onDownload={onDownload}
			>
				<PreviewErrorBoundary item={doc()}>
					<Viewer />
				</PreviewErrorBoundary>
			</PreviewDownloadableProvider>
		)

		expect(screen.getByText("This preview couldn't be displayed.")).toBeTruthy()
		expect(screen.getByText("notes.md")).toBeTruthy()

		act(() => {
			screen.getByRole("button", { name: "Download" }).click()
		})
		expect(onDownload).toHaveBeenCalledTimes(1)

		state.throws = false
		act(() => {
			screen.getByRole("button", { name: "Try again" }).click()
		})
		expect(screen.getByText("rendered")).toBeTruthy()
	})
})
