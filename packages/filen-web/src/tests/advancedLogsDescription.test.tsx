// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest"
import { createElement, type ComponentType } from "react"
import { render, screen } from "@testing-library/react"

// Settings → Advanced: the logs description states the ring buffer's real cap, never a copy of the number.

// A cap the shipped value never takes, so the copy can only show it by reading the constant.
const { cap } = vi.hoisted(() => ({ cap: 321 }))

vi.mock("@/lib/log", () => ({
	LOG_RING_MAX: cap,
	log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), dump: () => [] }
}))
vi.mock("@/features/settings/components/advanced/transferConfigRow", () => ({ TransferConfigRow: () => null }))
vi.mock("@/features/settings/components/advanced/archiveMemoryRow", () => ({ ArchiveMemoryRow: () => null }))
vi.mock("@/features/settings/components/advanced/uploadsRow", () => ({ UploadsRow: () => null }))
vi.mock("@/features/settings/components/advanced/logsBlock", () => ({ LogsBlock: () => null }))
vi.mock("@/features/settings/components/advanced/aboutRows", () => ({ AboutRows: () => null }))
vi.mock("@/features/settings/components/advanced/versionRow", () => ({ VersionRow: () => null }))
vi.mock("@/features/settings/components/advanced/thirdPartyNoticesRow", () => ({ ThirdPartyNoticesRow: () => null }))
vi.mock("@/features/settings/components/advanced/dotFilenRow", () => ({ DotFilenRow: () => null }))
vi.mock("@/features/settings/components/storage/storageCaches", () => ({ StorageCaches: () => null }))

const { i18n } = await import("@/lib/i18n")
const { Route } = await import("@/routes/_app/settings/advanced")

const AdvancedPage = Route.options.component as ComponentType

describe("the Advanced page's logs description", () => {
	it("shows the log ring buffer's cap", () => {
		render(createElement(AdvancedPage))

		const description = i18n.t("settings:settingsLogsDescription", { count: cap })

		expect(description).toContain(String(cap))
		expect(screen.getByText(description)).toBeTruthy()
	})
})
