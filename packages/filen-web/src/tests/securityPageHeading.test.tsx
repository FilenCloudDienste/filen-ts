// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { createElement, type ComponentType } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { UserInfo } from "@filen/sdk-rs"

// The Security page's heading is the sidebar's nav label (and the tab title): one key, so they never diverge.

const { getUserInfo } = vi.hoisted(() => ({ getUserInfo: vi.fn<() => Promise<UserInfo>>() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getUserInfo } }))
vi.mock("@/queries/client", () => ({
	queryClient: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
}))
vi.mock("@/features/settings/components/security/changePassword", () => ({ ChangePasswordRow: () => null }))
vi.mock("@/features/settings/components/security/exportMasterKeys", () => ({ ExportMasterKeysRow: () => null }))
vi.mock("@/features/settings/components/security/deleteAccount", () => ({ DeleteAccountRow: () => null }))
vi.mock("@/features/settings/components/security/twoFactor", () => ({ TwoFactorRow: () => null }))

const { i18n } = await import("@/lib/i18n")
const { queryClient } = await import("@/queries/client")
const { Route } = await import("@/routes/_app/settings/security")

const SecurityPage = Route.options.component as ComponentType
const original = i18n.t("settings:settingsSectionSecurity")

afterEach(() => {
	cleanup()
	i18n.addResource("en", "settings", "settingsSectionSecurity", original)
})

describe("SecurityPage heading", () => {
	it("renders the Security section's nav label", async () => {
		// A wording only the nav label's key carries, so the heading cannot match through another key.
		i18n.addResource("en", "settings", "settingsSectionSecurity", "Security section")
		getUserInfo.mockResolvedValueOnce({ email: "user@example.com" } as UserInfo)

		render(createElement(QueryClientProvider, { client: queryClient }, createElement(SecurityPage)))

		expect(await screen.findByRole("heading", { name: "Security section" })).toBeTruthy()
	})
})
