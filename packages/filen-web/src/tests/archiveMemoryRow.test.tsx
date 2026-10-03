// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement } from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const { kvStore, archiveCodecMemBudget, toastInfo } = vi.hoisted(() => ({
	kvStore: new Map<string, unknown>(),
	archiveCodecMemBudget: vi.fn<() => Promise<number>>(),
	toastInfo: vi.fn()
}))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	}
}))
vi.mock("@/features/drive/lib/archiveHelpers", () => ({ archiveCodecMemBudget }))
vi.mock("sonner", () => ({ toast: { info: toastInfo } }))
// The select itself is the shared row's concern; a button per option drives onChange here.
vi.mock("@/features/settings/components/settingRows", () => ({
	SettingsSelectRow: (props: {
		label: string
		description: string
		options: readonly { value: string; label: string }[]
		value: string | undefined
		onChange: (value: string) => void
	}) =>
		createElement(
			"div",
			null,
			createElement("p", null, props.label),
			createElement("p", { "data-testid": "description" }, props.description),
			createElement("p", { "data-testid": "value" }, props.value ?? "loading"),
			props.options.map(option =>
				createElement(
					"button",
					{
						key: option.value,
						type: "button",
						onClick: () => {
							props.onChange(option.value)
						}
					},
					option.label
				)
			)
		)
}))

import "@/lib/i18n"
import { ArchiveMemoryRow } from "@/features/settings/components/advanced/archiveMemoryRow"

const MIB = 1024 * 1024
const KEY = "settings.archiveConfig.v1"

function renderRow(): void {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

	render(createElement(QueryClientProvider, { client }, createElement(ArchiveMemoryRow)))
}

function description(): string {
	return screen.getByTestId("description").textContent
}

beforeEach(() => {
	kvStore.clear()
	archiveCodecMemBudget.mockResolvedValue(128 * MIB)
})

afterEach(() => {
	cleanup()
})

describe("ArchiveMemoryRow", () => {
	it("offers the four sizes with the default marked and explains the trade-off", async () => {
		renderRow()

		await screen.findByText("128")

		expect(screen.getAllByRole("button").map(button => button.textContent)).toEqual([
			"64 MiB",
			"128 MiB (default)",
			"256 MiB",
			"512 MiB"
		])
		expect(screen.getByText("Archive memory")).toBeDefined()
		expect(description()).toContain("higher compression levels")
		expect(description()).toContain("keeps the memory until it is closed")
		expect(description()).toContain("next time Filen loads")
		expect(description()).not.toContain("In effect now")
	})

	it("stores the choice and says it applies at the next load", async () => {
		renderRow()

		await screen.findByText("128")
		await act(async () => {
			screen.getByText("512 MiB").click()
			await new Promise(resolve => setTimeout(resolve, 0))
		})

		expect(kvStore.get(KEY)).toEqual({ codecMemoryMib: 512 })
		expect(toastInfo).toHaveBeenCalledWith("This takes effect the next time Filen loads in this browser tab.")
		await screen.findByText("512")
		await vi.waitFor(() => {
			expect(description()).toContain("In effect now: 128 MiB.")
		})
	})

	it("names the value in effect when it differs from the saved one", async () => {
		kvStore.set(KEY, { codecMemoryMib: 64 })
		archiveCodecMemBudget.mockResolvedValue(256 * MIB)
		renderRow()

		await screen.findByText("64")
		await vi.waitFor(() => {
			expect(description()).toContain("In effect now: 256 MiB.")
		})
	})

	it("says nothing about the value in effect when it can't be read", async () => {
		kvStore.set(KEY, { codecMemoryMib: 64 })
		archiveCodecMemBudget.mockRejectedValue(new Error("no client"))
		renderRow()

		await screen.findByText("64")
		await act(async () => {
			await new Promise(resolve => setTimeout(resolve, 0))
		})

		expect(description()).not.toContain("In effect now")
		expect(archiveCodecMemBudget).toHaveBeenCalledTimes(1)
	})
})
