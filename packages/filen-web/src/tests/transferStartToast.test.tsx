import { beforeEach, describe, expect, it, vi } from "vitest"
import { isValidElement, type ReactNode } from "react"

const { toast } = vi.hoisted(() => ({
	toast: Object.assign(
		vi.fn<(message: string, options?: { action?: unknown; id?: unknown }) => string>(() => "toast-id"),
		{ dismiss: vi.fn() }
	)
}))

vi.mock("sonner", () => ({ toast }))

import "@/lib/i18n"
import { toastTransferStarted } from "@/features/transfers/lib/transferStartToast"

function lastAction(): { to?: unknown; onClick?: () => void; children?: ReactNode } {
	const action = toast.mock.lastCall?.[1]?.action

	return isValidElement<{ to?: unknown; onClick?: () => void; children?: ReactNode }>(action) ? action.props : {}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("toastTransferStarted", () => {
	it("names a single file or a directory's zip", () => {
		toastTransferStarted({ direction: "download", name: "report.pdf", count: 1, noun: "items" })

		expect(toast.mock.lastCall?.[0]).toBe("Downloading report.pdf")
	})

	it("counts the items of a multi-item zip", () => {
		toastTransferStarted({ direction: "download", name: "Filen.zip", count: 3, noun: "items" })

		expect(toast.mock.lastCall?.[0]).toBe("Downloading 3 items")
	})

	it("offers a View link to the transfers screen that dismisses the toast", () => {
		toastTransferStarted({ direction: "download", name: "report.pdf", count: 1, noun: "items" })

		const action = lastAction()

		expect(action.to).toBe("/transfers")
		expect(action.children).toBe("View")

		action.onClick?.()

		expect(toast.dismiss).toHaveBeenCalledWith("toast-id")
	})

	it("names one upload, and counts picked files or mixed items", () => {
		toastTransferStarted({ direction: "upload", name: "Photos", count: 1, noun: "items" })

		expect(toast.mock.lastCall?.[0]).toBe("Uploading Photos")

		toastTransferStarted({ direction: "upload", name: "a.txt", count: 24, noun: "files" })

		expect(toast.mock.lastCall?.[0]).toBe("Uploading 24 files")

		toastTransferStarted({ direction: "upload", name: "a.txt", count: 2, noun: "items" })

		expect(toast.mock.lastCall?.[0]).toBe("Uploading 2 items")
	})

	it("replaces the toast it is given in place", () => {
		toastTransferStarted({ direction: "upload", name: "Photos", count: 1, noun: "items" }, "scan")

		expect(toast.mock.lastCall?.[1]?.id).toBe("scan")
	})
})
