// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { QueryClient } from "@tanstack/react-query"
import { EMPTY_BLOCKED_USERS } from "@filen/shared"

// A failed chats read says why and offers a retry, as the contacts list does.

const { useChats } = vi.hoisted(() => ({ useChats: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))
vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, children }: { to: string; children?: ReactNode }) => createElement("a", { href: to }, children),
	useNavigate: () => () => undefined,
	useRouter: () => ({}),
	useRouterState: () => "/chats"
}))
vi.mock("@/features/chats/queries/chats", () => ({ useChats }))
vi.mock("@/queries/account", () => ({ useAccountQuery: () => ({ data: { id: 1n } }) }))
vi.mock("@/features/contacts/hooks/useBlockedUsers", () => ({ useBlockedUsers: () => EMPTY_BLOCKED_USERS }))
vi.mock("@/features/shell/components/sidebarPanel", () => ({
	ResizableSidebarPanel: ({ children }: { children?: ReactNode }) => createElement("div", null, children)
}))

import "@/lib/i18n"
import { ChatsSidebar } from "@/features/chats/components/chatsSidebar"
import { plainErrorDTO } from "@/lib/sdk/errors"
import { registerAllActions } from "@/lib/keymap/actions"

registerAllActions()

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe("ChatsSidebar load error", () => {
	it("shows the reason and a Try again button that reads the list again", () => {
		const refetch = vi.fn(() => Promise.resolve())

		useChats.mockReturnValue({
			data: undefined,
			isPending: false,
			isError: true,
			error: plainErrorDTO("Disk full"),
			refetch
		})

		render(createElement(ChatsSidebar))

		const alert = screen.getByRole("alert")

		expect(alert.textContent).toContain("Disk full")

		fireEvent.click(screen.getByRole("button", { name: "Try again" }))

		expect(refetch).toHaveBeenCalledOnce()
	})
})
