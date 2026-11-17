// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import type { File, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"
import { narrowItem } from "@/features/drive/lib/item"
import { registerAllActions } from "@/lib/keymap/actions"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"

// An executable opens on a card of its headers (never run), read in ranges through the byte layer; one opened as text
// without the name that says what it is shows the same card from the bytes the text path holds.

function elf(): Uint8Array {
	const bytes = new Uint8Array(0x200)
	const view = new DataView(bytes.buffer)

	bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0], 0)
	view.setUint16(16, 2, true)
	view.setUint16(18, 183, true)

	return bytes
}

const { reads } = vi.hoisted(() => ({ reads: { count: 0, closed: 0 } }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: () => Promise.resolve(null),
	kvSetJson: () => Promise.resolve(),
	kvDelete: () => Promise.resolve()
}))
vi.mock("@/features/preview/hooks/usePreviewBytes", () => ({
	usePreviewBytes: () => ({ status: "success", bytes: elf(), refetch: vi.fn() })
}))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { cancelPreviewDownload: () => Promise.resolve() } }))
vi.mock("@/features/preview/lib/origin/byteReader", () => ({
	openByteReader: () => {
		const bytes = elf()

		return Promise.resolve({
			size: bytes.length,
			read: (offset: number, length: number) => {
				reads.count++

				return Promise.resolve(bytes.slice(offset, offset + length))
			},
			close: () => {
				reads.closed++
			}
		})
	}
}))

const { BinaryInfoViewer } = await import("@/features/preview/components/binaryInfoViewer")
const { TextViewer } = await import("@/features/preview/components/textViewer")

registerAllActions()

afterEach(() => {
	cleanup()
	reads.count = 0
	reads.closed = 0
})

function itemNamed(name: string) {
	return narrowItem({
		uuid: "file-0000-0000-0000-000000000000",
		stableUUID: undefined,
		parent: "parent-0000-0000-0000-000000000000" as UuidStr,
		size: 512n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "application/octet-stream", modified: 0n, size: 512n, key: "k", version: 2 } }
	} satisfies File)
}

describe("BinaryInfoViewer", () => {
	it("shows the headers' facts and closes its reader", async () => {
		render(<BinaryInfoViewer item={itemNamed("tool.so")} />, { wrapper: queryClientWrapper(createTestQueryClient()) })

		expect(await screen.findByText("ELF executable (64-bit, ARM64)")).toBeTruthy()
		expect(screen.getByText("Never run. Read from the file's headers only.")).toBeTruthy()
		expect(reads.count).toBeGreaterThan(0)
		expect(reads.closed).toBe(1)
	})
})

describe("TextViewer on an executable", () => {
	it("shows the headers' card instead of the not-text notice, from the bytes it holds", async () => {
		render(
			<TextViewer
				item={itemNamed("tool")}
				alt="tool"
			/>,
			{ wrapper: queryClientWrapper(createTestQueryClient()) }
		)

		expect(await screen.findByText("ELF executable (64-bit, ARM64)")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Show anyway" })).toBeNull()
		expect(reads.count).toBe(0)
	})
})
