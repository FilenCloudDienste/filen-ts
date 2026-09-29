// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import type { File, FilePublicLink, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

const { updateLink, accountState, refetchAccount } = vi.hoisted(() => {
	const state: { current: Record<string, unknown> } = { current: {} }

	return { updateLink: vi.fn(), accountState: state, refetchAccount: vi.fn() }
})

vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client() }
})
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock("@/features/drive/hooks/useThumbnail", () => ({ useThumbnail: () => null }))
vi.mock("@/features/drive/lib/thumbnails", () => ({ invalidateThumbnail: vi.fn() }))
vi.mock("@tanstack/react-router", () => ({
	Link: ({ children }: { children: ReactNode }) => createElement("a", null, children)
}))
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
	useDriveItemLinkStatusQuery: () => ({ status: "success", data: { type: "file", status: LINK } })
}))

import { narrowItem } from "@/features/drive/lib/item"
import { LinkDialog } from "@/features/drive/components/linkDialog"

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
	accountState.current = { status: "success", data: { isPremium: true }, error: null, refetch: refetchAccount }
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
	fireEvent.change(screen.getByPlaceholderText("No password"), { target: { value: plaintext } })

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
		expect(screen.getByPlaceholderText<HTMLInputElement>("No password").value).toBe("correct horse battery staple")
	})

	it("closes the password editor once the save lands", async () => {
		updateLink.mockResolvedValueOnce({ status: "success", link: { type: "file", status: LINK } })
		renderDialog()

		await savePassword("correct horse battery staple")

		expect(screen.getByRole("button", { name: "Set password" })).toBeTruthy()
	})

	it("offers a retry when the account read failed with nothing cached, instead of spinning", () => {
		accountState.current = { status: "error", data: undefined, error: new Error("server error"), refetch: refetchAccount }
		renderDialog()

		fireEvent.click(screen.getByRole("button", { name: "Try again" }))

		expect(refetchAccount).toHaveBeenCalledTimes(1)
	})
})
