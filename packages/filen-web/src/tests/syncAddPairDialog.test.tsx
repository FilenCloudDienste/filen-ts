// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { ComponentType, ReactNode } from "react"
import "@/lib/i18n"

// Leaving the Sync section while addPair is still answering: the pair it answers with is removed (its plan released),
// not left behind paused, and the dialog is closed so returning does not reopen it.

const { api, closeAddPair } = vi.hoisted(() => ({
	api: {
		chooseLocalDirectory: vi.fn(),
		addPair: vi.fn(),
		removePair: vi.fn(),
		releasePlan: vi.fn(),
		startPair: vi.fn()
	},
	closeAddPair: vi.fn()
}))

vi.mock("@/features/sync/lib/syncStore", () => ({
	syncApi: () => api,
	closeAddPair,
	useSyncStore: (select: (state: { addPairOpen: boolean }) => unknown) => select({ addPairOpen: false })
}))
vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => vi.fn(),
	Outlet: () => null,
	redirect: vi.fn(),
	createFileRoute: () => (options: { component: ComponentType }) => ({ options })
}))
vi.mock("@/queries/account", () => ({ useAccountQuery: () => ({ data: { rootDirUuid: "root-uuid" } }) }))
vi.mock("@/features/drive/hooks/useDirectoryPicker", () => ({
	useDirectoryPicker: () => ({
		targetUuid: "remote-uuid",
		pathStack: ["remote-uuid"],
		listingQuery: { status: "success", data: [] },
		namesQuery: { data: { "remote-uuid": "Work" } },
		enter: vi.fn()
	})
}))
// Only the new-directory row the dialog hands it.
vi.mock("@/features/sync/components/remoteDirectoryChooser", () => ({
	RemoteDirectoryChooser: ({ leading }: { leading?: { node: ReactNode } | undefined }) => leading?.node ?? null
}))
vi.mock("@/features/sync/components/reviewCard", () => ({ ReviewSummary: () => null }))

const { AddPairDialog } = await import("@/features/sync/components/addPairDialog")
const { Route } = await import("@/routes/_app/sync")

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe("AddPairDialog", () => {
	it("removes the pair addPair answers with after the dialog unmounted", async () => {
		let answer: (value: unknown) => void = () => undefined

		api.chooseLocalDirectory.mockResolvedValue({ status: "ok", id: "token", path: "/Users/a/Projects", name: "Projects", warnings: [] })
		api.addPair.mockReturnValue(
			new Promise(resolve => {
				answer = resolve
			})
		)
		api.removePair.mockResolvedValue({ ok: true, value: undefined })
		api.releasePlan.mockResolvedValue(undefined)

		const { unmount } = render(<AddPairDialog onClose={vi.fn()} />)

		fireEvent.click(screen.getByRole("button", { name: "Choose directory" }))
		await screen.findByText("/Users/a/Projects")
		fireEvent.click(screen.getByRole("button", { name: "Next" }))
		fireEvent.click(screen.getByRole("button", { name: "Next" }))
		fireEvent.click(screen.getByRole("button", { name: "Next" }))
		fireEvent.click(screen.getByRole("button", { name: "Add pair" }))

		expect(api.addPair).toHaveBeenCalledTimes(1)

		unmount()

		await act(async () => {
			answer({ ok: true, value: { pairId: "pair-1", plan: { planId: "plan-1", summary: null } } })
			await Promise.resolve()
		})

		expect(api.releasePlan).toHaveBeenCalledWith("plan-1")
		expect(api.removePair).toHaveBeenCalledWith("pair-1")
	})
})

describe("AddPairDialog new directory", () => {
	it("is offered on the remote step only, its name row over the remote listing", async () => {
		api.chooseLocalDirectory.mockResolvedValue({ status: "ok", id: "token", path: "/Users/a/Projects", name: "Projects", warnings: [] })

		render(<AddPairDialog onClose={vi.fn()} />)

		expect(screen.queryByRole("button", { name: "New directory" })).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Choose directory" }))
		await screen.findByText("/Users/a/Projects")
		fireEvent.click(screen.getByRole("button", { name: "Next" }))
		fireEvent.click(screen.getByRole("button", { name: "New directory" }))

		expect(screen.getByRole("textbox", { name: "Name of the new directory" })).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "Next" }))

		expect(screen.queryByRole("button", { name: "New directory" })).toBeNull()
	})
})

describe("Sync layout", () => {
	it("closes the add-pair dialog when the section is left", () => {
		const Layout = (Route as unknown as { options: { component: ComponentType } }).options.component
		const { unmount } = render(<Layout />)

		closeAddPair.mockClear()
		unmount()

		expect(closeAddPair).toHaveBeenCalledTimes(1)
	})
})
