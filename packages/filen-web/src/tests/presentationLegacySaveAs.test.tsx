// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ConversionReport, PortLike, PresentationSessionApi } from "@filen/office/dom/presentation"
import { savePortWriter, type SavePortEnd } from "@filen/shared/savePort"
import "@/lib/i18n"
import type { DriveItem } from "@/features/drive/lib/item"
import { linkedFileItem } from "@/tests/fixtures/sdk"

// A PowerPoint 97–2003 deck's bar: view-only, and where a copy may be saved, Save as .pptx: the worker's package read
// from its port and uploaded beside the file; the copy opened, or what it holds differently listed in a dialog that
// stays until it is closed (the copy opened from there); a failed save says so.

const { uploads, toasts } = vi.hoisted(() => ({
	uploads: [] as { bytes: Uint8Array; extension: string }[],
	toasts: { success: [] as { message: string; description?: string }[], error: [] as string[] }
}))

vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock("sonner", () => ({
	toast: {
		success: (message: string, options?: { description?: string }) => toasts.success.push({ message, ...options }),
		error: (message: string) => toasts.error.push(message)
	}
}))
vi.mock("@/features/drive/lib/convertedCopy", () => ({
	uploadConvertedCopy: (item: DriveItem, bytes: Uint8Array, extension: string) => {
		uploads.push({ bytes, extension })

		return Promise.resolve({ status: "saved", item, name: "deck.pptx" })
	}
}))

// Ports in this realm: jsdom's typed arrays are not the ones a Node MessagePort hands over, which the save port's
// reader checks; messages arrive in a later task, as across a real port.
class LocalPort {
	other: LocalPort | undefined
	started = false
	private readonly listeners = new Set<(event: { readonly data: unknown }) => void>()

	postMessage(data: unknown): void {
		const other = this.other

		setTimeout(() => {
			for (const listener of other?.listeners ?? []) listener({ data })
		}, 0)
	}

	addEventListener(_type: "message", listener: (event: { readonly data: unknown }) => void): void {
		this.listeners.add(listener)
	}

	removeEventListener(_type: "message", listener: (event: { readonly data: unknown }) => void): void {
		this.listeners.delete(listener)
	}

	start(): void {
		this.started = true
	}

	close(): void {
		this.listeners.clear()
	}
}

const { LegacyPresentationBar } = await import("@/features/presentation/components/legacyView")

const item = linkedFileItem("deck.ppt", {
	uuid: "aaaaaaaa-0000-0000-0000-000000000011",
	mime: { Decrypted: "application/vnd.ms-powerpoint" },
	size: 12n
})

// A session whose freshParts writes `bytes` to the port in two chunks, or refuses without writing.
function session(bytes: Uint8Array | undefined, losses: ConversionReport["losses"] = []): PresentationSessionApi {
	return {
		async freshParts(target: "pptx" | "odp", port: PortLike): Promise<ConversionReport> {
			// A refusal comes before the port is written to.
			if (bytes === undefined) throw new Error("refused")

			const writer = savePortWriter(port as SavePortEnd, { lingerMs: 10 })

			writer.announce()
			await writer.write(bytes.subarray(0, 3))
			await writer.write(bytes.subarray(3))
			await writer.close()
			writer.commit()

			return { target, bytes: bytes.length, losses }
		}
	} as unknown as PresentationSessionApi
}

beforeEach(() => {
	vi.stubGlobal(
		"MessageChannel",
		class {
			readonly port1 = new LocalPort()
			readonly port2 = new LocalPort()

			constructor() {
				this.port1.other = this.port2
				this.port2.other = this.port1
			}
		}
	)
})

afterEach(() => {
	cleanup()
	uploads.length = 0
	toasts.success.length = 0
	toasts.error.length = 0
})

describe("PowerPoint 97–2003 bar", () => {
	it("says the deck is view-only and offers nothing where no copy may be saved", () => {
		render(<LegacyPresentationBar format="ppt" />)

		expect(screen.getByRole("status", { name: "Legacy format" }).textContent).toContain("It can be viewed but not edited here.")
		expect(screen.queryByRole("button", { name: "Save as .pptx" })).toBeNull()
	})

	it("shows nothing for a deck in a current format", () => {
		render(<LegacyPresentationBar format="pptx" />)

		expect(screen.queryByRole("status")).toBeNull()
	})

	it("saves the worker's package beside the file and opens it", async () => {
		const opened: DriveItem[] = []
		const bytes = Uint8Array.of(0x50, 0x4b, 3, 4, 9, 8, 7)

		render(
			<LegacyPresentationBar
				format="ppt"
				saveCopy={{ item, session: session(bytes), encrypted: false, onOpenFile: copy => opened.push(copy) }}
			/>
		)
		fireEvent.click(screen.getByRole("button", { name: "Save as .pptx" }))
		fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Save as .pptx" }))

		await waitFor(() => {
			expect(opened).toHaveLength(1)
		})
		expect(uploads).toEqual([{ bytes, extension: "pptx" }])
		expect(toasts.success).toEqual([{ message: "Saved as deck.pptx" }])
	})

	it("lists what the copy holds differently until the list is closed, and opens the copy from there", async () => {
		const opened: DriveItem[] = []
		const bytes = Uint8Array.of(0x50, 0x4b, 3, 4, 9, 8, 7)

		render(
			<LegacyPresentationBar
				format="ppt"
				saveCopy={{
					item,
					session: session(bytes, [
						{ kind: "oleObject", count: 2 },
						{ kind: "comment", count: 1 },
						{ kind: "macros", count: 1 }
					]),
					encrypted: true,
					onOpenFile: copy => opened.push(copy)
				}}
			/>
		)

		// The button is not part of the status note.
		expect(within(screen.getByRole("status", { name: "Legacy format" })).queryByRole("button")).toBeNull()
		fireEvent.click(screen.getByRole("button", { name: "Save as .pptx" }))

		const dialog = await screen.findByRole("alertdialog")

		expect(dialog.textContent).toContain("The copy is protected with the same password.")
		fireEvent.click(within(dialog).getByRole("button", { name: "Save as .pptx" }))

		const list = await screen.findByRole("alertdialog", { name: "Saved as deck.pptx" })

		expect(
			within(list)
				.getAllByRole("listitem")
				.map(entry => entry.textContent)
		).toEqual([
			"2 embedded objects that can't be opened in the copy",
			"Comments on 1 slide, left out",
			"Its macros, which the copy can't hold"
		])
		expect(uploads).toEqual([{ bytes, extension: "pptx" }])
		expect(toasts.success).toEqual([])
		expect(opened).toEqual([])

		// It stays until it is acted on.
		await new Promise(resolve => setTimeout(resolve, 50))
		expect(screen.getByRole("alertdialog", { name: "Saved as deck.pptx" })).toBeDefined()

		fireEvent.click(within(list).getByRole("button", { name: "Open the copy" }))

		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull()
		})
		expect(opened).toHaveLength(1)
	})

	it("closes the list of differences without opening the copy", async () => {
		const opened: DriveItem[] = []

		render(
			<LegacyPresentationBar
				format="ppt"
				saveCopy={{
					item,
					session: session(Uint8Array.of(1, 2, 3, 4), [{ kind: "media", count: 1 }]),
					encrypted: false,
					onOpenFile: copy => opened.push(copy)
				}}
			/>
		)
		fireEvent.click(screen.getByRole("button", { name: "Save as .pptx" }))
		fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Save as .pptx" }))

		const list = await screen.findByRole("alertdialog", { name: "Saved as deck.pptx" })

		expect(list.textContent).toContain("1 sound or movie that won't play in the copy")
		fireEvent.click(within(list).getByRole("button", { name: "Close" }))

		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull()
		})
		expect(opened).toEqual([])
	})

	it("says so when the deck could not be saved, and uploads nothing", async () => {
		render(
			<LegacyPresentationBar
				format="ppt"
				saveCopy={{ item, session: session(undefined), encrypted: false }}
			/>
		)
		fireEvent.click(screen.getByRole("button", { name: "Save as .pptx" }))

		const dialog = await screen.findByRole("alertdialog")

		expect(dialog.textContent).not.toContain("password")
		fireEvent.click(within(dialog).getByRole("button", { name: "Save as .pptx" }))

		await waitFor(() => {
			expect(toasts.error).toEqual(["This presentation could not be saved as .pptx"])
		})
		expect(uploads).toEqual([])
	})
})
