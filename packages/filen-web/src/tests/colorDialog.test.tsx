// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import type { Dir } from "@filen/sdk-rs"

const { setColor, saveRecentDirColors, loadRecentDirColors, online } = vi.hoisted(() => ({
	setColor: vi.fn((_dir: unknown, _color: string) => Promise.resolve({ status: "ok" })),
	saveRecentDirColors: vi.fn((_list: string[]) => undefined),
	loadRecentDirColors: vi.fn(() => Promise.resolve([] as string[])),
	online: { current: true }
}))

vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => online.current }))
vi.mock("@/features/drive/lib/actions", () => ({ setColor }))
vi.mock("@/features/drive/lib/recentDirColors", () => ({ saveRecentDirColors, loadRecentDirColors }))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { ColorDialog } from "@/features/drive/components/colorDialog"
import { DIR_COLOR_SWATCHES, withRecentDirColor } from "@/features/drive/lib/dirColor"
import { testUuid } from "@/tests/support/uuid"

function directory(color: string): Extract<DriveItem, { type: "directory" }> {
	const raw: Dir = {
		uuid: testUuid("dir"),
		parent: testUuid("parent"),
		color,
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name: "d" } }
	}
	const item = narrowItem(raw)

	if (item.type !== "directory") {
		throw new Error("expected a directory")
	}

	return item
}

const onClose = vi.fn()

function renderDialog(color = "default"): void {
	render(createElement(ColorDialog, { directory: directory(color), onClose }))
}

beforeEach(() => {
	online.current = true
	loadRecentDirColors.mockResolvedValue([])
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe("withRecentDirColor", () => {
	it("puts the newest first, dedupes and caps at five", () => {
		expect(withRecentDirColor(["#111111", "#222222"], "#222222")).toEqual(["#222222", "#111111"])
		expect(withRecentDirColor(["#1", "#2", "#3", "#4", "#5"], "#6")).toEqual(["#6", "#1", "#2", "#3", "#4"])
	})

	it("never records a curated swatch", () => {
		expect(withRecentDirColor(["#111111"], "#ff9500")).toEqual(["#111111"])
	})
})

describe("ColorDialog", () => {
	it("renders every swatch as a radio and marks the current one", () => {
		renderDialog("blue")

		expect(screen.getAllByRole("radio")).toHaveLength(DIR_COLOR_SWATCHES.length)
		expect(screen.getByRole("radio", { name: "Blue" }).getAttribute("aria-checked")).toBe("true")
		expect(screen.getByRole("radio", { name: "Red" }).getAttribute("aria-checked")).toBe("false")
	})

	it("stores a named preset by name", async () => {
		renderDialog()
		fireEvent.click(screen.getByRole("radio", { name: "Green" }))

		await waitFor(() => {
			expect(onClose).toHaveBeenCalled()
		})
		expect(setColor.mock.calls[0]?.[1]).toBe("green")
		expect(saveRecentDirColors).not.toHaveBeenCalled()
	})

	it("stores an extra swatch as a custom hex without recording a recent", async () => {
		renderDialog()
		fireEvent.click(screen.getByRole("radio", { name: "Orange" }))

		await waitFor(() => {
			expect(onClose).toHaveBeenCalled()
		})
		expect(setColor.mock.calls[0]?.[1]).toBe("#ff9500")
		expect(saveRecentDirColors).not.toHaveBeenCalled()
	})

	it("applies a typed custom hex only when valid, and records it as recent", async () => {
		renderDialog()
		fireEvent.click(screen.getByRole("button", { name: "Custom color" }))

		const input = await screen.findByLabelText("Hex value")
		const apply = screen.getByRole("button", { name: "Apply" })

		fireEvent.change(input, { target: { value: "#12" } })
		expect((apply as HTMLButtonElement).disabled).toBe(true)

		fireEvent.change(input, { target: { value: "#1A2B3C" } })
		expect((apply as HTMLButtonElement).disabled).toBe(false)
		fireEvent.click(apply)

		await waitFor(() => {
			expect(onClose).toHaveBeenCalled()
		})
		expect(setColor.mock.calls[0]?.[1]).toBe("#1a2b3c")
		expect(saveRecentDirColors).toHaveBeenCalledWith(["#1a2b3c"])
	})

	it("offers recent colors and applies one", async () => {
		loadRecentDirColors.mockResolvedValue(["#123456", "#654321"])
		renderDialog()

		fireEvent.click(await screen.findByRole("radio", { name: "#654321" }))

		await waitFor(() => {
			expect(onClose).toHaveBeenCalled()
		})
		expect(setColor.mock.calls[0]?.[1]).toBe("#654321")
		expect(saveRecentDirColors).toHaveBeenCalledWith(["#654321", "#123456"])
	})

	it("does not close when the SDK call fails", async () => {
		setColor.mockResolvedValueOnce({ status: "error", dto: { kind: "Unknown", message: "x" } } as never)
		renderDialog()
		fireEvent.click(screen.getByRole("radio", { name: "Red" }))

		await waitFor(() => {
			expect(setColor).toHaveBeenCalled()
		})
		expect(onClose).not.toHaveBeenCalled()
	})

	it("disables the swatches offline", () => {
		online.current = false
		renderDialog()

		expect(screen.getByRole("radio", { name: "Red" }).getAttribute("aria-disabled")).toBe("true")
	})
})
