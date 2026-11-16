// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { PreviewUnsupportedState } from "@/features/preview/components/previewErrorState"
import { PreviewDownloadableProvider } from "@/features/preview/lib/accessMode"
import { linkedFileItem } from "@/tests/fixtures/sdk"
import "@/lib/i18n"

const ITEM = linkedFileItem("scan_2024.psb", { size: 1887436800n })

describe("PreviewUnsupportedState", () => {
	it("names the file with its size, in a calm message", () => {
		render(
			<PreviewUnsupportedState
				item={ITEM}
				message="This format can't be shown."
			/>
		)

		expect(screen.getByText("scan_2024.psb")).toBeTruthy()
		expect(screen.getByText("1.76 GiB")).toBeTruthy()

		const message = screen.getByText("This format can't be shown.")

		expect(message.className).toContain("text-muted-foreground")
		expect(message.className).not.toContain("destructive")
	})

	it("offers no Download where the host offers none", () => {
		render(
			<PreviewDownloadableProvider downloadable={false}>
				<PreviewUnsupportedState
					item={ITEM}
					message="Unsupported."
				/>
			</PreviewDownloadableProvider>
		)

		expect(screen.queryByRole("button")).toBeNull()
	})

	it("offers the host's Download beside one secondary action", () => {
		const onDownload = vi.fn()

		render(
			<PreviewDownloadableProvider
				downloadable
				onDownload={onDownload}
			>
				<PreviewUnsupportedState
					item={ITEM}
					message="Unsupported."
					secondary={<button type="button">Open anyway</button>}
				/>
			</PreviewDownloadableProvider>
		)

		fireEvent.click(screen.getByRole("button", { name: /download/i }))
		expect(onDownload).toHaveBeenCalledTimes(1)
		expect(screen.getByRole("button", { name: "Open anyway" })).toBeTruthy()
	})
})
