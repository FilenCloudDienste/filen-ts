// @vitest-environment jsdom

// Settings → Advanced → About → Version: the build the page came from, copied whole; absent in the desktop app, which
// names its version under Settings → Desktop → About.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"

const { copyText, bridge } = vi.hoisted(() => ({
	copyText: vi.fn<(text: string, successMessage: string) => Promise<boolean>>(() => Promise.resolve(true)),
	bridge: { current: undefined as object | undefined }
}))

vi.mock("@/lib/copyText", () => ({ copyText }))
vi.mock("@/lib/desktop", () => ({ desktopBridge: () => bridge.current }))

const { i18n } = await import("@/lib/i18n")
const { VersionRow } = await import("@/features/settings/components/advanced/versionRow")

const COMMIT = "0123456789abcdef0123456789abcdef01234567"

beforeEach(() => {
	vi.clearAllMocks()
	bridge.current = undefined
})

afterEach(() => {
	cleanup()
	vi.unstubAllEnvs()
})

describe("VersionRow", () => {
	it("shows the start of the commit and copies all of it", () => {
		vi.stubEnv("VITE_BUILD_ID", COMMIT)
		render(createElement(VersionRow))

		expect(screen.getByText(i18n.t("settings:settingsVersionTitle"))).toBeTruthy()
		expect(screen.getByText(COMMIT.slice(0, 12))).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: i18n.t("settings:settingsVersionCopy") }))

		expect(copyText).toHaveBeenCalledWith(COMMIT, i18n.t("settings:settingsVersionCopied"))
	})

	it("names a local build and copies it as local", () => {
		vi.stubEnv("VITE_BUILD_ID", undefined)
		render(createElement(VersionRow))

		expect(screen.getByText(i18n.t("settings:settingsVersionLocal"))).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: i18n.t("settings:settingsVersionCopy") }))

		expect(copyText).toHaveBeenCalledWith("local", i18n.t("settings:settingsVersionCopied"))
	})

	it("is absent in the desktop app", () => {
		bridge.current = {}
		vi.stubEnv("VITE_BUILD_ID", COMMIT)

		const { container } = render(createElement(VersionRow))

		expect(container.innerHTML).toBe("")
	})
})
