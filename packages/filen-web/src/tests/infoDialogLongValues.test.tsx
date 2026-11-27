// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, render, screen, waitFor } from "@testing-library/react"
import type { Dir, File } from "@filen/sdk-rs"
import "@/lib/i18n"

const { getItemInfo } = vi.hoisted(() => ({
	getItemInfo: vi.fn<(item: Dir | File) => Promise<{ path: string | null; ancestors: Dir[] }>>()
}))

vi.mock("@/lib/sdk/client", () => ({
	sdkApi: {
		getItemInfo,
		getDirSize: vi.fn(),
		getFileLinkStatus: () => Promise.resolve(null),
		listSharedOutRoot: () => Promise.resolve({ dirs: [], files: [] })
	}
}))

vi.mock("@/queries/client", async () => ({ queryClient: (await import("@/tests/testQueryClient")).createTestQueryClient() }))

vi.mock("@/features/drive/hooks/useThumbnail", () => ({ useThumbnail: () => null }))
vi.mock("@/features/drive/lib/thumbnails", () => ({ invalidateThumbnail: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: ReactNode }) => createElement("a", null, children)
}))

import { queryClient } from "@/queries/client"
import { queryClientWrapper } from "@/tests/testQueryClient"
import { narrowItem } from "@/features/drive/lib/item"
import { formatItemSize } from "@/features/drive/lib/format"
import { InfoDialog } from "@/features/drive/components/infoDialog"
import { testUuid } from "@/tests/support/uuid"

const LONG_PATH = "Projects/2026/Clients/Acme Corporation International/Quarterly Reports/Final Drafts/"
const LONG_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation"

function mockFile(): File {
	return {
		uuid: testUuid("longValues"),
		stableUUID: undefined,
		parent: testUuid("parent"),
		size: 1_024n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 1_700_000_000_000n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: {
			type: "decoded",
			data: { name: "deck.pptx", mime: LONG_MIME, modified: 1_700_000_000_000n, size: 1_024n, key: "k", version: 2 }
		}
	}
}

// The value span of the row whose content contains `text`.
function valueCell(text: string): HTMLElement {
	const cell = screen.getByText(text).closest(".select-text")

	if (!(cell instanceof HTMLElement)) {
		throw new Error(`no value cell for ${text}`)
	}

	return cell
}

describe("InfoDialog long values", () => {
	it("wraps the full path and MIME type instead of truncating them, short rows stay on one line", async () => {
		getItemInfo.mockResolvedValueOnce({ path: LONG_PATH, ancestors: [] })
		const item = narrowItem(mockFile())

		render(createElement(InfoDialog, { item, variant: "drive", onClose: vi.fn() }), {
			wrapper: queryClientWrapper(queryClient)
		})

		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 0))
		})
		await waitFor(() => {
			expect(screen.getByText(LONG_PATH.replace(/\/$/, ""))).toBeTruthy()
		})

		const pathCell = valueCell(LONG_PATH.replace(/\/$/, ""))
		expect(pathCell.textContent).toBe(LONG_PATH.replace(/\/$/, ""))
		expect(pathCell.classList.contains("truncate")).toBe(false)
		expect(pathCell.classList.contains("break-words")).toBe(true)

		const mimeCell = valueCell(LONG_MIME)
		expect(mimeCell.classList.contains("truncate")).toBe(false)
		expect(mimeCell.classList.contains("break-words")).toBe(true)

		const sizeCell = valueCell(formatItemSize(item))
		expect(sizeCell.classList.contains("truncate")).toBe(true)
		expect(sizeCell.classList.contains("break-words")).toBe(false)
	})
})
