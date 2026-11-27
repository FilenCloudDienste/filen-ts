// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import type { File, FilePublicLink, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

const { updateLink, accountState, refetchAccount, linkState } = vi.hoisted(() => {
	const state: { current: Record<string, unknown> } = { current: {} }
	const link: { current: unknown } = { current: undefined }

	return { updateLink: vi.fn(), accountState: state, refetchAccount: vi.fn(), linkState: link }
})

vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client() }
})
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/features/drive/hooks/useThumbnail", () => ({ useThumbnail: () => null }))
vi.mock("@/features/drive/lib/thumbnails", () => ({ invalidateThumbnail: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children, to, search }: { children: ReactNode; to: string; search?: { view?: string } }) =>
		createElement("a", { href: search?.view === undefined ? to : `${to}?view=${search.view}` }, children)
}))
const { desktopBridge } = vi.hoisted(() => ({ desktopBridge: vi.fn<() => object | undefined>(() => undefined) }))

vi.mock("@/lib/desktop", () => ({ desktopBridge, desktopPlatform: () => undefined }))
vi.mock("@/queries/account", () => ({ useAccountQuery: () => accountState.current }))
vi.mock("@/features/drive/lib/actions", () => ({ createLink: vi.fn(), disableLink: vi.fn(), updateLink }))

const LINK: FilePublicLink = {
	linkUuid: "link-0000-0000-0000-000000000000",
	password: { type: "none" },
	expiration: "never",
	downloadable: true,
	salt: "salt"
}

vi.mock("@/features/drive/queries/drive", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/queries/drive")>()),
	useDriveItemLinkStatusQuery: () => ({ status: "success", data: linkState.current })
}))

import { narrowItem } from "@/features/drive/lib/item"
import { LinkDialog } from "@/features/drive/components/linkDialog"
import { formatDateTime } from "@/lib/formatDate"

const FILE = narrowItem({
	uuid: "file-0000-0000-0000-000000000000" as UuidStr,
	stableUUID: undefined,
	parent: "parent-0000-0000-0000-000000000000" as UuidStr,
	size: 1n,
	favorited: false,
	region: "de-1",
	bucket: "filen-1",
	timestamp: 0n,
	chunks: 1n,
	canMakeThumbnail: false,
	meta: { type: "decoded", data: { name: "report.pdf", mime: "application/pdf", modified: 0n, size: 1n, key: "key", version: 2 } }
} satisfies File)

beforeEach(() => {
	linkState.current = { type: "file", status: LINK }
	accountState.current = { status: "success", data: { subs: [{ activated: true }] }, error: null, refetch: refetchAccount }
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

function renderDialog(): void {
	render(createElement(LinkDialog, { item: FILE, onClose: vi.fn() }))
}

async function savePassword(plaintext: string): Promise<void> {
	fireEvent.click(screen.getByRole("button", { name: "Set password" }))
	fireEvent.change(screen.getByLabelText("Password"), { target: { value: plaintext } })

	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Save" }))
		await Promise.resolve()
	})
}

describe("LinkDialog", () => {
	it("keeps the password editor and the typed password when saving it fails", async () => {
		updateLink.mockResolvedValueOnce({ status: "error", dto: { species: "plain", message: "boom", label: "boom" } })
		renderDialog()

		await savePassword("correct horse battery staple")

		expect(updateLink).toHaveBeenCalledTimes(1)
		expect(screen.getByLabelText<HTMLInputElement>("Password").value).toBe("correct horse battery staple")
	})

	it("closes the password editor once the save lands", async () => {
		updateLink.mockResolvedValueOnce({ status: "success", link: { type: "file", status: LINK } })
		renderDialog()

		await savePassword("correct horse battery staple")

		expect(screen.getByRole("button", { name: "Set password" })).toBeTruthy()
	})

	it("saves the password exactly as typed, edge spaces included", async () => {
		updateLink.mockResolvedValueOnce({ status: "success", link: { type: "file", status: LINK } })
		renderDialog()

		await savePassword(" secret ")

		const [item, update] = updateLink.mock.calls[0] as [unknown, { status: { password: unknown } }]

		expect(item).toBe(FILE)
		expect(update.status.password).toEqual({ type: "known", data: " secret " })
	})

	it("keeps Save disabled for a whitespace-only password", () => {
		renderDialog()
		fireEvent.click(screen.getByRole("button", { name: "Set password" }))
		fireEvent.change(screen.getByLabelText("Password"), { target: { value: "   " } })

		expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true)
	})

	it("names the password input by its label, not a placeholder", () => {
		renderDialog()
		fireEvent.click(screen.getByRole("button", { name: "Set password" }))

		const input = screen.getByLabelText<HTMLInputElement>("Password")

		expect(input.tagName).toBe("INPUT")
		expect(input.placeholder).toBe("")
		expect(input.id).not.toMatch(/password/i)
	})

	it("offers a retry when the account read failed with nothing cached, instead of spinning", () => {
		accountState.current = { status: "error", data: undefined, error: new Error("server error"), refetch: refetchAccount }
		renderDialog()

		fireEvent.click(screen.getByRole("button", { name: "Try again" }))

		expect(refetchAccount).toHaveBeenCalledTimes(1)
	})
})

describe("LinkDialog details", () => {
	it("shows the end-to-end encryption note when no link exists yet", () => {
		linkState.current = null
		renderDialog()

		expect(screen.getByText("Anyone with the link can access this item.")).toBeTruthy()
		expect(screen.getByText("End-to-end encrypted: the key after # in the link never reaches Filen's servers.")).toBeTruthy()
	})

	it("shows the actual expiry date for a link that expires", () => {
		const expiresAt = 1795874400000n

		linkState.current = { type: "file", status: { ...LINK, expiration: "1d", expiresAt } }
		renderDialog()

		expect(screen.getByText(`Expires ${formatDateTime(expiresAt)}`)).toBeTruthy()
	})

	it("shows no expiry line for a link that never expires or whose expiry is not reported", () => {
		linkState.current = { type: "file", status: { ...LINK, expiresAt: 1795874400000n } }
		renderDialog()

		expect(screen.queryByText(/^Expires /)).toBeNull()

		cleanup()
		linkState.current = { type: "file", status: { ...LINK, expiration: "1d" } }
		renderDialog()

		expect(screen.queryByText(/^Expires /)).toBeNull()
	})

	it("saves the typed password when the form is submitted with Enter", async () => {
		updateLink.mockResolvedValueOnce({ status: "success", link: { type: "file", status: LINK } })
		renderDialog()
		fireEvent.click(screen.getByRole("button", { name: "Set password" }))
		fireEvent.change(screen.getByLabelText("Password"), { target: { value: "hunter2" } })

		const form = screen.getByLabelText("Password").closest("form")

		if (form === null) {
			throw new Error("password form missing")
		}

		await act(async () => {
			fireEvent.submit(form)
			await Promise.resolve()
		})

		expect(updateLink).toHaveBeenCalledTimes(1)
	})

	it("asks before removing the password and keeps it when cancelled", async () => {
		linkState.current = { type: "file", status: { ...LINK, password: { type: "known", data: "x" } } }
		updateLink.mockResolvedValue({ status: "success", link: { type: "file", status: LINK } })
		renderDialog()

		fireEvent.click(screen.getByRole("button", { name: "Remove password" }))

		expect(screen.getByText("Remove the password?")).toBeTruthy()
		expect(updateLink).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		expect(updateLink).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole("button", { name: "Remove password" }))

		const confirm = screen.getAllByRole("button", { name: "Remove password" }).at(-1)

		if (confirm === undefined) {
			throw new Error("confirm button missing")
		}

		await act(async () => {
			fireEvent.click(confirm)
			await Promise.resolve()
		})

		const [, update] = updateLink.mock.calls[0] as [unknown, { status: { password: unknown } }]

		expect(update.status.password).toEqual({ type: "none" })
	})
})

describe("LinkDialog premium gate", () => {
	beforeEach(() => {
		accountState.current = { status: "success", data: { subs: [] }, error: null, refetch: refetchAccount }
	})

	it("sends a free account to the plans on the web", () => {
		desktopBridge.mockReturnValue(undefined)
		renderDialog()

		expect(screen.getByRole("link", { name: "Upgrade" }).getAttribute("href")).toBe("/settings/plans")
	})

	it("opens web billing in the browser from the desktop app", () => {
		desktopBridge.mockReturnValue({})
		renderDialog()

		const link = screen.getByRole("link", { name: "Upgrade" })

		expect(link.getAttribute("href")).toBe("https://app.filen.io/settings/billing")
		expect(link.getAttribute("target")).toBe("_blank")
		expect(link.getAttribute("rel")).toBe("noopener noreferrer")
	})
})
