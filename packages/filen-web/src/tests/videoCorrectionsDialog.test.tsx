// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { emptyLibraryConfig, newSeriesId } from "@filen/shared/videos"
import "@/lib/i18n"

// The corrections dialog's own logic: what blocks a save and how it says so, a save that changes nothing writing
// nothing, a failed save keeping the dialog open, and the page following an item shown as another title now.

const { editLibraryConfig, toastError } = vi.hoisted(() => ({
	editLibraryConfig: vi.fn<(edit: unknown) => Promise<unknown>>(),
	toastError: vi.fn()
}))

vi.mock("@/features/videos/queries/library", () => ({
	editLibraryConfig,
	useLibraryConfigQuery: () => ({ data: { account: "root", doc: emptyLibraryConfig(), dirUuid: null } })
}))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("sonner", () => ({ toast: { error: toastError } }))

const { CorrectionsDialog } = await import("@/features/videos/components/detail/correctionsDialog")

type Subject = Parameters<typeof CorrectionsDialog>[0]["subject"]

const MOVIE: Subject = {
	key: "d:dir",
	original: { kind: "movie", title: "Heat", year: 1995, season: 0, episode: 0, episodeEnd: 0, seriesKey: "" },
	seriesId: "",
	mergeKey: "",
	autoMergedRoots: 1
}

function renderDialog(subject: Subject = MOVIE) {
	const onClose = vi.fn()
	const onMoved = vi.fn()

	render(
		<CorrectionsDialog
			subject={subject}
			series={[{ id: "show", title: "Show" }]}
			onClose={onClose}
			onMoved={onMoved}
		/>
	)

	return { onClose, onMoved }
}

function field(name: string): HTMLInputElement {
	return screen.getByRole<HTMLInputElement>("textbox", { name })
}

function type(name: string, value: string): void {
	fireEvent.change(field(name), { target: { value } })
}

// Picks a select's option as a mouse does.
function choose(option: HTMLElement): void {
	fireEvent.pointerDown(option, { pointerType: "mouse", button: 0 })
	fireEvent.mouseDown(option, { button: 0 })
	fireEvent.pointerUp(option, { pointerType: "mouse", button: 0 })
	fireEvent.mouseUp(option, { button: 0 })
	fireEvent.click(option)
}

async function showAs(kind: string): Promise<void> {
	fireEvent.click(screen.getByRole("combobox", { name: "Show as" }))
	choose(await screen.findByRole("option", { name: kind }))
	await waitFor(() => {
		expect(screen.getByRole("combobox", { name: "Show as" }).textContent).toContain(kind)
	})
}

function save(): void {
	fireEvent.click(screen.getByRole("button", { name: "Save" }))
}

afterEach(() => {
	cleanup()
})

describe("CorrectionsDialog", () => {
	it("says why an empty title can't be saved, tied to the field, and writes nothing", () => {
		const { onClose } = renderDialog()

		type("Title", "  ")
		save()

		const error = screen.getByText("Enter a title.")

		expect(field("Title").getAttribute("aria-invalid")).toBe("true")
		expect(field("Title").getAttribute("aria-describedby")).toBe(error.id)
		expect(error.id).not.toBe("")
		expect(editLibraryConfig).not.toHaveBeenCalled()
		expect(onClose).not.toHaveBeenCalled()
	})

	it("closes without a write when nothing changed", () => {
		const { onClose, onMoved } = renderDialog()

		save()

		expect(onClose).toHaveBeenCalledOnce()
		expect(onMoved).not.toHaveBeenCalled()
		expect(editLibraryConfig).not.toHaveBeenCalled()
	})

	it("stays open with the save available again when the save fails", async () => {
		editLibraryConfig.mockRejectedValueOnce(new Error("offline"))

		const { onClose } = renderDialog()

		type("Title", "Heat!")
		save()

		await waitFor(() => {
			expect(toastError).toHaveBeenCalledOnce()
		})
		await waitFor(() => {
			expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false)
		})
		expect(editLibraryConfig).toHaveBeenCalledOnce()
		expect(onClose).not.toHaveBeenCalled()
	})

	it("ties the missing season and episode error to all three number fields", async () => {
		renderDialog()

		await showAs("Episode")
		save()

		const error = screen.getByText("An episode needs its season and episode number.")

		expect(error.id).not.toBe("")

		for (const name of ["Season", "Episode", "Last episode (optional, for a multi-episode file)"]) {
			expect(field(name).getAttribute("aria-describedby")).toBe(error.id)
		}

		expect(editLibraryConfig).not.toHaveBeenCalled()
	})

	it("follows a movie turned into an episode of a new series, a hidden bad year not blocking it", async () => {
		editLibraryConfig.mockResolvedValueOnce({})

		const { onClose, onMoved } = renderDialog()

		type("Year", "19")
		await showAs("Episode")
		expect(screen.queryByRole("textbox", { name: "Year" })).toBeNull()
		type("Season", "1")
		type("Episode", "2")
		save()

		await waitFor(() => {
			expect(onMoved).toHaveBeenCalledExactlyOnceWith(newSeriesId("dir"))
		})
		expect(editLibraryConfig).toHaveBeenCalledOnce()
		expect(onClose).toHaveBeenCalledOnce()
	})
})
