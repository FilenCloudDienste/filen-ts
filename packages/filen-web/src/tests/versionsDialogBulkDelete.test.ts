// @vitest-environment jsdom

// Deleting several versions runs as an activity whose running state the panel's own spinner shows: only
// its result toasts, and the panel stays open.
import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import { QueryClient } from "@tanstack/react-query"
import type { File, FileVersion } from "@filen/sdk-rs"
import "@/lib/i18n"

const { deleteVersions, toast, versions } = vi.hoisted(() => {
	function version(uuid: string, timestamp: bigint): FileVersion {
		return {
			uuid,
			stableUUID: "55555555-5555-5555-5555-555555555555",
			region: "de-1",
			bucket: "filen-1",
			chunks: 1n,
			timestamp,
			size: 512n,
			metadata: {
				type: "decoded",
				data: { name: "report.pdf", mime: "application/pdf", modified: timestamp, size: 512n, key: "key", version: 2 }
			}
		} as FileVersion
	}

	return {
		deleteVersions: vi.fn(),
		toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }),
		versions: [
			version("44444444-4444-4444-4444-444444444444", 1_600_000_000_000n),
			version("88888888-8888-8888-8888-888888888888", 1_500_000_000_000n)
		]
	}
})

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("sonner", () => ({ toast }))
vi.mock("@/features/drive/lib/actions", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/actions")>()),
	deleteVersions
}))
vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	useFileVersionsQuery: () => ({ status: "success", data: versions })
}))

import { VersionsDialog } from "@/features/drive/components/versionsDialog"
import { narrowItem } from "@/features/drive/lib/item"
import { type FileItem } from "@/features/drive/lib/actions"

function asFileItem(source: File): FileItem {
	const item = narrowItem(source)

	if (item.type !== "file") {
		throw new Error("expected a file item")
	}

	return item
}

const file = asFileItem({
	uuid: "22222222-2222-2222-2222-222222222222",
	stableUUID: "55555555-5555-5555-5555-555555555555",
	parent: "33333333-3333-3333-3333-333333333333",
	size: 1_024n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 1_700_000_000_000n,
	chunks: 1n,
	canMakeThumbnail: true,
	meta: {
		type: "decoded",
		data: { name: "report.pdf", mime: "application/pdf", modified: 1_700_000_000_000n, size: 1_024n, key: "key", version: 2 }
	}
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe("VersionsDialog deleting every old version", () => {
	it("keeps the panel's spinner while it runs, then toasts only the result", async () => {
		const [kept, failing] = versions
		let finish: (outcome: unknown) => void = () => undefined
		deleteVersions.mockReturnValue(
			new Promise(resolve => {
				finish = resolve
			})
		)
		const onClose = vi.fn()
		render(createElement(VersionsDialog, { file, onClose }))

		fireEvent.click(screen.getByRole("button", { name: "Delete all" }))

		fireEvent.click(screen.getByRole("button", { name: "Delete selected" }))

		expect(deleteVersions).toHaveBeenCalledExactlyOnceWith(file, versions, expect.any(Function))
		expect(toast).not.toHaveBeenCalled()

		await act(async () => {
			finish({ succeeded: [kept], failed: [{ item: failing, error: { species: "plain", message: "no", label: "no" } }] })
			await Promise.resolve()
		})

		expect(toast.error).toHaveBeenCalledExactlyOnceWith("Deleted 1 version, 1 failed", expect.anything())
		expect(onClose).not.toHaveBeenCalled()
	})
})
