// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

const { kvStore, navigate } = vi.hoisted(() => ({
	kvStore: new Map<string, unknown>(),
	navigate: vi.fn((_options: { to: string }) => Promise.resolve())
}))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	},
	kvDelete: (key: string) => {
		kvStore.delete(key)

		return Promise.resolve()
	}
}))
vi.mock("@/lib/desktop", () => ({ isDesktopApp: () => false, desktopBridge: () => undefined }))
vi.mock("@/queries/account", () => ({ useMasterKeysNotExported: () => false }))
vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, children, ...rest }: { to: string; children?: ReactNode }) => createElement("a", { ...rest, href: to }, children),
	useRouter: () => ({ navigate, state: { location: { pathname: "/settings/account" } } })
}))

await import("@/lib/i18n")

const { registerAllActions } = await import("@/lib/keymap/actions")
const { SettingsSidebar } = await import("@/features/settings/components/settingsSidebar")
const { takeSettingsHighlight } = await import("@/lib/settingsHighlight")
const { usePageSearchClaim } = await import("@/features/settings/lib/settingsSearch")

registerAllActions()

function searchBox(): HTMLInputElement {
	return screen.getByRole<HTMLInputElement>("combobox", { name: "Search settings" })
}

function type(value: string): void {
	fireEvent.change(searchBox(), { target: { value } })
}

beforeEach(() => {
	Element.prototype.scrollIntoView = vi.fn()
	navigate.mockClear()
	render(<SettingsSidebar />)
})

afterEach(() => {
	cleanup()
	takeSettingsHighlight()
})

describe("SettingsSidebar search", () => {
	it("replaces the section list with matching settings, each with its page", () => {
		expect(screen.getByRole("link", { name: "Appearance" })).toBeTruthy()

		type("theme")

		expect(screen.queryByRole("link", { name: "Appearance" })).toBeNull()

		const option = screen.getAllByRole("option")[0]

		expect(option?.textContent).toContain("Theme")
		expect(option?.textContent).toContain("Appearance")
		expect(option?.getAttribute("aria-selected")).toBe("true")
		expect(searchBox().getAttribute("aria-activedescendant")).toBe(option?.id)
	})

	it("opens the setting's page and asks it to ring the row on Enter", () => {
		type("theme")
		fireEvent.keyDown(searchBox(), { key: "Enter" })

		expect(navigate).toHaveBeenCalledWith({ to: "/settings/appearance" })
		expect(takeSettingsHighlight()).toBe("theme")
	})

	it("moves through the results with the arrow keys, wrapping", () => {
		type("password")

		const options = screen.getAllByRole("option")

		expect(options.length).toBeGreaterThan(1)

		fireEvent.keyDown(searchBox(), { key: "ArrowDown" })

		expect(searchBox().getAttribute("aria-activedescendant")).toBe(options[1]?.id)

		fireEvent.keyDown(searchBox(), { key: "ArrowUp" })
		fireEvent.keyDown(searchBox(), { key: "ArrowUp" })

		expect(searchBox().getAttribute("aria-activedescendant")).toBe(options.at(-1)?.id)
	})

	it("opens a clicked result", () => {
		type("language")

		const option = screen.getAllByRole("option").find(candidate => candidate.textContent.startsWith("Language"))

		expect(option).toBeTruthy()

		if (option !== undefined) {
			fireEvent.click(option)
		}

		expect(navigate).toHaveBeenCalledWith({ to: "/settings/appearance" })
		expect(takeSettingsHighlight()).toBe("language")
	})

	it("says when nothing matches", () => {
		type("zzzqqq")

		expect(screen.queryByRole("option")).toBeNull()
		expect(screen.getByRole("status").textContent).toBe("No matching settings")
	})

	it("restores the section list on Escape", () => {
		type("theme")
		fireEvent.keyDown(searchBox(), { key: "Escape" })

		expect(searchBox().value).toBe("")
		expect(screen.getByRole("link", { name: "Appearance" })).toBeTruthy()
	})

	it("focuses the search on Mod+F, unless the page has a search of its own", () => {
		function pressModF(): void {
			act(() => {
				document.body.dispatchEvent(
					new KeyboardEvent("keydown", { key: "f", code: "KeyF", ctrlKey: true, metaKey: true, bubbles: true, cancelable: true })
				)
			})
		}

		pressModF()

		expect(document.activeElement).toBe(searchBox())

		searchBox().blur()

		function PageSearch() {
			usePageSearchClaim(true)

			return null
		}

		const page = render(<PageSearch />)

		pressModF()

		expect(document.activeElement).not.toBe(searchBox())

		page.unmount()
	})
})
