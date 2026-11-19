// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import type { UserAccountSubs } from "@filen/sdk-rs"

// The account button's name: "Account" alone, or one whole phrase with the withdrawal notice folded in, so a
// translator can order and punctuate it.
const { withdrawal } = vi.hoisted(() => ({
	withdrawal: { current: undefined as { sub: UserAccountSubs; until: string } | undefined }
}))

vi.mock("@/queries/account", async () => ({
	...(await vi.importActual<object>("@/queries/account")),
	useAccountQuery: () => ({ data: undefined })
}))
vi.mock("@/features/settings/hooks/useWithdrawalNotice", () => ({
	useWithdrawalNotice: () => ({ now: 0, notice: withdrawal.current })
}))
vi.mock("@/features/shell/hooks/useUnsyncedWork", () => ({ useHasUnsyncedWork: () => false }))
vi.mock("@/providers/themeProvider", () => ({ useTheme: () => ({ toggleTheme: vi.fn() }) }))
vi.mock("@tanstack/react-router", async () => ({
	...(await vi.importActual<object>("@tanstack/react-router")),
	useNavigate: () => vi.fn()
}))

import "@/lib/i18n"
import { common } from "@/locales/en/common"
import { AccountMenu } from "@/features/shell/components/iconRail"
import { registerAllActions } from "@/lib/keymap/actions"

// The menu binds its keys.
registerAllActions()

describe("AccountMenu", () => {
	it("names the account button by one phrase holding the withdrawal notice", () => {
		withdrawal.current = { sub: {} as UserAccountSubs, until: "12/31/2026" }

		try {
			render(<AccountMenu />)

			expect(common.accountWithStatus).toBe("Account: {{status}}")
			expect(screen.getByRole("button", { name: "Account: contract withdrawal possible until 12/31/2026" })).toBeTruthy()
		} finally {
			withdrawal.current = undefined
		}
	})

	it("names the account button Account without a notice", () => {
		render(<AccountMenu />)

		expect(screen.getByRole("button", { name: "Account" })).toBeTruthy()
	})
})
