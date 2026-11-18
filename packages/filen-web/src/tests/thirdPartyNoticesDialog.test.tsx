// @vitest-environment jsdom

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"
import type { DesktopThirdPartyNotices } from "@filen/shared/desktop"
import { ThirdPartyNoticesDialog } from "@/features/settings/components/advanced/thirdPartyNoticesDialog"
import { createTestQueryClient, queryClientWrapper } from "@/tests/testQueryClient"

const mocks = vi.hoisted(() => ({
	bridge: undefined as undefined | { app: { thirdPartyNotices: () => Promise<DesktopThirdPartyNotices> } }
}))

vi.mock("@/lib/desktop", () => ({ desktopBridge: () => mocks.bridge }))

const SHELL: DesktopThirdPartyNotices = {
	texts: ["Shell-only license terms."],
	notices: [
		{
			name: "zz-desktop-shell-only",
			version: "9.9.9",
			license: "MIT",
			ecosystem: "vendored",
			copyright: ["Copyright Shell Holder"],
			repository: null,
			texts: [0]
		}
	]
}

function open() {
	render(createElement(ThirdPartyNoticesDialog, { open: true, onOpenChange: () => undefined }), {
		wrapper: queryClientWrapper(createTestQueryClient())
	})
	fireEvent.change(screen.getByPlaceholderText("Filter packages"), { target: { value: "zz-desktop-shell" } })
}

// jsdom lays nothing out, and the virtualized list renders only the rows its scroll element has room for.
const SIZES = { clientHeight: 384, clientWidth: 512 }
const originals = new Map<string, PropertyDescriptor | undefined>()

beforeAll(() => {
	for (const [name, size] of Object.entries(SIZES)) {
		originals.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name))
		Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => size })
	}
})

afterAll(() => {
	for (const [name, descriptor] of originals) {
		if (descriptor !== undefined) {
			Object.defineProperty(HTMLElement.prototype, name, descriptor)
		}
	}
})

afterEach(() => {
	cleanup()
	mocks.bridge = undefined
})

describe("ThirdPartyNoticesDialog", () => {
	it("in the desktop app, lists the shell's notices with their own texts", async () => {
		const thirdPartyNotices = vi.fn(() => Promise.resolve(SHELL))

		mocks.bridge = { app: { thirdPartyNotices } }
		open()
		fireEvent.click(await screen.findByRole("button", { name: /zz-desktop-shell-only/ }))

		expect(screen.getByText("Copyright Shell Holder")).toBeDefined()
		expect(screen.getByText("Shell-only license terms.")).toBeDefined()
		expect(thirdPartyNotices).toHaveBeenCalledTimes(1)
	})

	it("in a browser, lists the web build's notices only and asks no shell", () => {
		open()

		expect(screen.queryByRole("button", { name: /zz-desktop-shell-only/ })).toBeNull()
	})

	it("keeps the web build's notices when the shell's cannot be read", async () => {
		const thirdPartyNotices = vi.fn(() => Promise.reject(new Error("unreadable")))

		mocks.bridge = { app: { thirdPartyNotices } }
		render(createElement(ThirdPartyNoticesDialog, { open: true, onOpenChange: () => undefined }), {
			wrapper: queryClientWrapper(createTestQueryClient())
		})
		await vi.waitFor(() => {
			expect(thirdPartyNotices).toHaveBeenCalledTimes(1)
		})

		fireEvent.change(screen.getByPlaceholderText("Filter packages"), { target: { value: "react-dom" } })

		expect(screen.getAllByRole("button", { name: /react-dom/ }).length).toBeGreaterThan(0)
	})
})
