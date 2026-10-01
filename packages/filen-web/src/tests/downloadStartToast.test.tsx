import { beforeEach, describe, expect, it, vi } from "vitest"
import { isValidElement, type ReactNode } from "react"

const { toast } = vi.hoisted(() => ({
	toast: Object.assign(
		vi.fn<(message: string, options?: { action?: unknown }) => string>(() => "toast-id"),
		{ dismiss: vi.fn() }
	)
}))

vi.mock("sonner", () => ({ toast }))

import "@/lib/i18n"
import { toastDownloadStarted } from "@/features/transfers/lib/downloadStartToast"

function lastAction(): { to?: unknown; onClick?: () => void; children?: ReactNode } {
	const action = toast.mock.lastCall?.[1]?.action

	return isValidElement<{ to?: unknown; onClick?: () => void; children?: ReactNode }>(action) ? action.props : {}
}

beforeEach(() => {
	vi.clearAllMocks()
})

describe("toastDownloadStarted", () => {
	it("names a single file or a directory's zip", () => {
		toastDownloadStarted("report.pdf", 1)

		expect(toast.mock.lastCall?.[0]).toBe("Downloading report.pdf")
	})

	it("counts the items of a multi-item zip", () => {
		toastDownloadStarted("Filen.zip", 3)

		expect(toast.mock.lastCall?.[0]).toBe("Downloading 3 items")
	})

	it("offers a View link to the transfers screen that dismisses the toast", () => {
		toastDownloadStarted("report.pdf", 1)

		const action = lastAction()

		expect(action.to).toBe("/transfers")
		expect(action.children).toBe("View")

		action.onClick?.()

		expect(toast.dismiss).toHaveBeenCalledWith("toast-id")
	})
})
