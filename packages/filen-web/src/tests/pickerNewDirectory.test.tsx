// @vitest-environment jsdom

// The directory pickers' New directory: a footer button opening a name row over the listing, which creates the
// directory in the one open and opens it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import type { UseQueryResult } from "@tanstack/react-query"
import type { Dir, UuidStr } from "@filen/sdk-rs"
import "@/lib/i18n"

const { createDirectory, itemNameError, online } = vi.hoisted(() => ({
	createDirectory: vi.fn(),
	itemNameError: vi.fn(),
	online: { current: true }
}))

vi.mock("@/features/drive/lib/actions", () => ({ createDirectory }))
vi.mock("@/features/drive/lib/archiveHelpers", () => ({ itemNameError }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => online.current }))
vi.mock("@/lib/i18n/errorLabel", () => ({ errorLabel: () => "The server refused it" }))

import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { PickerListShell } from "@/features/drive/components/directoryPicker"
import { usePickerNewDirectory, type UsePickerNewDirectoryParams } from "@/features/drive/hooks/usePickerNewDirectory"
import { cancelsOnBlur, localDraftError } from "@/features/drive/lib/pickerNewDirectory.logic"

const DOCS = "docs-0000-0000-0000-000000000000"
const WORK = "work-0000-0000-0000-000000000000"
const NEW = "new0-0000-0000-0000-000000000000"

function dir(uuid: string, name: string): DriveItem {
	return narrowItem({
		uuid: uuid as UuidStr,
		parent: DOCS as UuidStr,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	} satisfies Dir)
}

function pickerAt({ uuid, listing, status = "success" }: { uuid: string; listing: DriveItem[]; status?: "success" | "pending" }) {
	return {
		pathStack: [uuid],
		targetUuid: uuid,
		listingQuery: { status, data: status === "success" ? listing : undefined } as unknown as UseQueryResult<DriveItem[]>,
		enter: vi.fn<UsePickerNewDirectoryParams["picker"]["enter"]>()
	}
}

function Harness(props: UsePickerNewDirectoryParams) {
	const newDirectory = usePickerNewDirectory(props)

	return (
		<>
			<PickerListShell
				listingQuery={props.picker.listingQuery}
				count={0}
				rowKey={String}
				renderRow={() => null}
				leading={newDirectory.leading}
			/>
			{newDirectory.button}
			<span data-testid="pending">{String(newDirectory.pending)}</span>
		</>
	)
}

function nameField(): HTMLInputElement {
	return screen.getByRole("textbox", { name: "Name of the new directory" })
}

function open(picker: UsePickerNewDirectoryParams["picker"], props?: Partial<UsePickerNewDirectoryParams>) {
	const view = render(
		<Harness
			picker={picker}
			available
			disabled={false}
			{...props}
		/>
	)

	fireEvent.click(screen.getByRole("button", { name: "New directory" }))

	return view
}

function type(value: string): void {
	fireEvent.change(nameField(), { target: { value } })
}

function press(key: string): void {
	fireEvent.keyDown(nameField(), { key })
}

beforeEach(() => {
	online.current = true
	itemNameError.mockResolvedValue(null)
	createDirectory.mockResolvedValue({ status: "success", item: dir(NEW, "Reports") })
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe("localDraftError", () => {
	it("refuses a blank name and one the directory already holds, in any case", () => {
		const listing = [dir(WORK, "Reports")]

		expect(localDraftError("   ", listing)).toEqual({ kind: "empty" })
		expect(localDraftError(" reports ", listing)).toEqual({ kind: "taken" })
		expect(localDraftError("Invoices", listing)).toBeNull()
	})

	it("drops the row on blur only when nothing is typed and nothing is under way", () => {
		expect(cancelsOnBlur({ parentUuid: null, name: " ", pending: false, error: null })).toBe(true)
		expect(cancelsOnBlur({ parentUuid: null, name: "a", pending: false, error: null })).toBe(false)
		expect(cancelsOnBlur({ parentUuid: null, name: "", pending: true, error: null })).toBe(false)
	})
})

describe("usePickerNewDirectory", () => {
	it("opens a focused name row over an empty listing instead of its empty state", () => {
		render(
			<Harness
				picker={pickerAt({ uuid: DOCS, listing: [] })}
				available
				disabled={false}
			/>
		)

		expect(screen.getByText("Nothing here yet")).toBeTruthy()

		fireEvent.click(screen.getByRole("button", { name: "New directory" }))

		expect(document.activeElement).toBe(nameField())
		expect(screen.queryByText("Nothing here yet")).toBeNull()
	})

	it("creates the trimmed name in the open directory, then opens it", async () => {
		const picker = pickerAt({ uuid: DOCS, listing: [] })

		open(picker)
		type("  Reports ")

		await act(async () => {
			press("Enter")
			await Promise.resolve()
		})

		expect(itemNameError).toHaveBeenCalledWith("Reports")
		expect(createDirectory).toHaveBeenCalledExactlyOnceWith(DOCS, "Reports")
		expect(picker.enter).toHaveBeenCalledExactlyOnceWith(DOCS, NEW)
		expect(screen.queryByRole("textbox", { name: "Name of the new directory" })).toBeNull()
	})

	it("shows a spinner and reports pending while it creates", async () => {
		let answer: (value: unknown) => void = () => undefined

		createDirectory.mockReturnValue(
			new Promise(resolve => {
				answer = resolve
			})
		)
		open(pickerAt({ uuid: DOCS, listing: [] }))
		type("Reports")

		await act(async () => {
			press("Enter")
			await Promise.resolve()
		})

		expect(screen.getByTestId("pending").textContent).toBe("true")
		expect(screen.getByRole("status")).toBeTruthy()
		expect(screen.getByRole("button", { name: "New directory" })).toHaveProperty("disabled", true)

		await act(async () => {
			answer({ status: "success", item: dir(NEW, "Reports") })
			await Promise.resolve()
		})

		expect(screen.getByTestId("pending").textContent).toBe("false")
	})

	it("refuses an empty name inline, creating nothing", async () => {
		open(pickerAt({ uuid: DOCS, listing: [] }))
		press("Enter")

		expect((await screen.findByRole("alert")).textContent).toBe("Enter a name")
		expect(nameField().getAttribute("aria-invalid")).toBe("true")
		expect(createDirectory).not.toHaveBeenCalled()
	})

	it("refuses a name the directory holds, whatever its case, without asking anything", async () => {
		open(pickerAt({ uuid: DOCS, listing: [dir(WORK, "Reports")] }))
		type("REPORTS")
		press("Enter")

		expect((await screen.findByRole("alert")).textContent).toBe("A file or directory with this name already exists here.")
		expect(itemNameError).not.toHaveBeenCalled()
		expect(createDirectory).not.toHaveBeenCalled()
	})

	it("shows the SDK's reason for a name it refuses", async () => {
		itemNameError.mockResolvedValue("TrailingDotOrSpace")
		open(pickerAt({ uuid: DOCS, listing: [] }))
		type("Reports.")
		press("Enter")

		expect((await screen.findByRole("alert")).textContent).toBe("Names can't end with a dot or a space")
		expect(createDirectory).not.toHaveBeenCalled()
	})

	it("keeps the row with the create's error inline, and clears it on typing", async () => {
		createDirectory.mockResolvedValue({ status: "error", dto: {} })

		const picker = pickerAt({ uuid: DOCS, listing: [] })

		open(picker)
		type("Reports")
		press("Enter")

		expect((await screen.findByRole("alert")).textContent).toBe("The server refused it")
		expect(picker.enter).not.toHaveBeenCalled()
		expect(screen.getByTestId("pending").textContent).toBe("false")

		type("Reports 2")

		expect(screen.queryByRole("alert")).toBeNull()
	})

	it("cancels on Escape without letting it reach the dialog", () => {
		const outer = vi.fn()

		document.addEventListener("keydown", outer)
		open(pickerAt({ uuid: DOCS, listing: [] }))
		type("Reports")
		press("Escape")
		document.removeEventListener("keydown", outer)

		expect(screen.queryByRole("textbox", { name: "Name of the new directory" })).toBeNull()
		expect(outer).not.toHaveBeenCalled()
	})

	it("cancels on blur only while the name is empty", () => {
		open(pickerAt({ uuid: DOCS, listing: [] }))
		type("Reports")
		fireEvent.blur(nameField())

		expect(nameField().value).toBe("Reports")

		type("")
		fireEvent.blur(nameField())

		expect(screen.queryByRole("textbox", { name: "Name of the new directory" })).toBeNull()
	})

	it("drops the row when the picker opens another directory", () => {
		const { rerender } = open(pickerAt({ uuid: DOCS, listing: [] }))

		rerender(
			<Harness
				picker={pickerAt({ uuid: WORK, listing: [] })}
				available
				disabled={false}
			/>
		)

		expect(screen.queryByRole("textbox", { name: "Name of the new directory" })).toBeNull()
	})

	it("is not offered offline, nor where the host says nothing created could be picked", () => {
		online.current = false
		render(
			<Harness
				picker={pickerAt({ uuid: DOCS, listing: [] })}
				available
				disabled={false}
			/>
		)

		expect(screen.queryByRole("button", { name: "New directory" })).toBeNull()

		cleanup()
		online.current = true
		render(
			<Harness
				picker={pickerAt({ uuid: DOCS, listing: [] })}
				available={false}
				disabled={false}
			/>
		)

		expect(screen.queryByRole("button", { name: "New directory" })).toBeNull()
	})

	it("waits for the listing, and for the host's own work", () => {
		render(
			<Harness
				picker={pickerAt({ uuid: DOCS, listing: [], status: "pending" })}
				available
				disabled={false}
			/>
		)

		expect(screen.getByRole("button", { name: "New directory" })).toHaveProperty("disabled", true)

		cleanup()
		render(
			<Harness
				picker={pickerAt({ uuid: DOCS, listing: [] })}
				available
				disabled
			/>
		)

		expect(screen.getByRole("button", { name: "New directory" })).toHaveProperty("disabled", true)
	})
})
