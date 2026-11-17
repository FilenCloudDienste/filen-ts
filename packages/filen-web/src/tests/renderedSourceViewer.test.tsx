// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"
import { narrowItem } from "@/features/drive/lib/item"
import { registerAllActions } from "@/lib/keymap/actions"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"

// Any rendered text type (not only markdown) on the shared viewer: its renderer gets the bytes and the text decoded
// once; Source shows the same text, with markdown formatting only where asked for.

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))
vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: new TextEncoder().encode("graph TD; A-->B"), refetch: vi.fn() })
}))

const { RenderedSourceViewer } = await import("@/features/preview/components/renderedSourceViewer")

registerAllActions()

afterEach(() => {
	cleanup()
})

const ITEM = narrowItem({
	uuid: "file-0000-0000-0000-000000000000",
	stableUUID: undefined,
	parent: "parent-0000-0000-0000-000000000000" as UuidStr,
	size: 1n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: { type: "decoded", data: { name: "flow.mmd", mime: "text/plain", modified: 0n, size: 1n, key: "k", version: 2 } }
} satisfies File)

describe("RenderedSourceViewer", () => {
	it("renders through its renderer under its own names and shows the same text as source, without markdown formatting", async () => {
		const renderer = vi.fn(({ bytes, file }: { bytes: Uint8Array; file: { text: string } }) => (
			<p data-testid="rendered">{`${String(bytes.byteLength)}:${file.text}`}</p>
		))

		render(
			<RenderedSourceViewer
				item={ITEM}
				alt="flow.mmd"
				renderer={renderer}
				tag=""
				formatting={false}
				labels={{ view: "Diagram view", rendered: "Diagram" }}
				editable
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)

		expect(screen.getByTestId("rendered").textContent).toBe("15:graph TD; A-->B")
		expect(screen.getByRole("button", { name: "Diagram" }).getAttribute("aria-pressed")).toBe("true")

		fireEvent.click(screen.getByRole("button", { name: "Source" }))

		expect(await screen.findByText("graph TD; A-->B")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Bold" })).toBeNull()
	})
})
