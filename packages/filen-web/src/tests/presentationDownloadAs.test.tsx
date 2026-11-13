// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import type { ReactNode } from "react"
import type { File } from "@filen/sdk-rs"
import type { Format, GateReason } from "@filen/office/core/presentation"
import type { ConversionReport, PortLike, PresentationSessionApi } from "@filen/office/dom/presentation"
import { savePortWriter, type SavePortEnd } from "@filen/shared/savePort"
import "@/lib/i18n"

// The presentation File menu's Download as: the formats the open deck converts to, converted from its session (unsaved
// edits included) and downloaded as the item menus download them; nothing where the file may not be downloaded. A deck
// viewed only for what it is (Strict, signed, protected from changes) offers Save a copy as .pptx where a copy may be
// saved beside it, then says what the copy holds in a dialog with Open the copy (never opened by itself). The
// PowerPoint 97–2003 bar adds Save as .odp, not for a deck opened with its password.

const { start, uploads, toasts, online } = vi.hoisted(() => ({
	start: vi.fn(),
	uploads: [] as { bytes: Uint8Array; extension: string }[],
	toasts: { success: [] as string[], error: [] as string[], loading: [] as string[] },
	online: { current: true }
}))

vi.mock("@/lib/log", () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock("@/features/drive/lib/downloadAs", () => ({ startDownloadAs: start }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => online.current }))
vi.mock("sonner", () => ({
	toast: {
		success: (message: string) => toasts.success.push(message),
		error: (message: string) => toasts.error.push(message),
		loading: (message: string) => {
			toasts.loading.push(message)

			return 1
		},
		dismiss: vi.fn()
	}
}))
vi.mock("@/features/drive/lib/convertedCopy", () => ({
	uploadConvertedCopy: (item: unknown, bytes: Uint8Array, extension: string) => {
		uploads.push({ bytes, extension })

		return Promise.resolve({ status: "saved", item, name: `deck.${extension}` })
	}
}))
// The other owners' runs of the menu are left out: only Download as is under test.
vi.mock("@/features/presentation/components/fileMenu/export", () => ({ PresentationExportEntries: () => null }))
vi.mock("@/features/presentation/components/fileMenu/templates", () => ({ PresentationTemplatesEntries: () => null }))
vi.mock("@/features/presentation/components/fileMenu/save", () => ({
	PresentationSaveEntries: () => null,
	PresentationAutosaveEntry: () => null
}))

// Ports in this realm, as the legacy bar's test has them: messages in a later task, as across a real port.
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

const { narrowItem } = await import("@/features/drive/lib/item")
const { PreviewDownloadableProvider } = await import("@/features/preview/lib/accessMode")
const { PresentationEditorContext } = await import("@/features/presentation/hooks/usePresentationSession")
const { PresentationFileMenu } = await import("@/features/presentation/components/presentationFileMenu")
const { LegacyPresentationBar } = await import("@/features/presentation/components/legacyView")
const { PresentationDownloadAsMenu } = await import("@/features/presentation/components/fileMenu/downloadAs")
const { CommandFileMenu } = await import("@/features/preview/components/commandBarControls")
const { PreviewAccessModeProvider } = await import("@/features/preview/lib/accessMode")

type DriveItem = ReturnType<typeof narrowItem>

function file(name: string): DriveItem {
	return narrowItem({
		uuid: "33333333-3333-3333-3333-333333333333",
		stableUUID: undefined,
		parent: "22222222-2222-2222-2222-222222222222",
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "application/octet-stream", modified: 0n, size: 1n, key: "key", version: 2 } }
	} satisfies File)
}

// A session whose freshParts writes `bytes` in two chunks and reports `losses`, or refuses without writing.
function session(bytes: Uint8Array | undefined, losses: ConversionReport["losses"] = []): PresentationSessionApi {
	return {
		async freshParts(target: "pptx" | "odp", port: PortLike): Promise<ConversionReport> {
			if (bytes === undefined) throw new Error("refused")

			const writer = savePortWriter(port as SavePortEnd, { lingerMs: 10 })

			writer.announce()
			await writer.write(bytes.subarray(0, 2))
			await writer.write(bytes.subarray(2))
			await writer.close()
			writer.commit()

			return { target, bytes: bytes.length, losses }
		}
	} as unknown as PresentationSessionApi
}

interface Menu {
	readonly item: DriveItem
	readonly format: Format
	readonly session: PresentationSessionApi
	readonly gate?: readonly GateReason[]
	readonly downloads?: boolean
	readonly copy?: boolean
	readonly encrypted?: boolean
	readonly opened?: DriveItem[]
	readonly flush?: () => Promise<void>
}

function renderMenu(menu: Menu): void {
	const downloads = menu.downloads ?? true
	const scope = { editor: { document: { info: { gate: menu.gate ?? [] } } }, view: {} } as never
	const tree: ReactNode = (
		<PreviewDownloadableProvider
			downloadable={downloads}
			onDownload={vi.fn()}
		>
			<PresentationEditorContext value={scope}>
				<PresentationFileMenu
					context={{
						editable: false,
						downloads,
						item: menu.item,
						format: menu.format,
						session: menu.session,
						...(menu.flush === undefined ? {} : { text: { flush: menu.flush } }),
						...(menu.copy === true
							? {
									saveCopy: {
										item: menu.item,
										session: menu.session,
										encrypted: menu.encrypted ?? false,
										onOpenFile: (copy: DriveItem) => menu.opened?.push(copy)
									}
								}
							: {})
					}}
				/>
				<LegacyPresentationBar
					format={menu.format}
					{...(menu.copy === true
						? {
								saveCopy: {
									item: menu.item,
									session: menu.session,
									encrypted: menu.encrypted ?? false,
									onOpenFile: (copy: DriveItem) => menu.opened?.push(copy)
								}
							}
						: {})}
				/>
			</PresentationEditorContext>
		</PreviewDownloadableProvider>
	)

	render(tree)
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

async function openMenu(): Promise<void> {
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "File" }))
		await settle()
	})
}

async function openDownloadAs(): Promise<void> {
	await openMenu()

	const sub = screen.getByRole("menuitem", { name: "Download as" })

	await act(async () => {
		sub.focus()
		fireEvent.keyDown(sub, { key: "ArrowRight" })
		await settle()
	})
}

beforeEach(() => {
	start.mockReset()
	online.current = true
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
	toasts.loading.length = 0
})

describe("the presentation File menu's Download as", () => {
	it("offers .odp for a PowerPoint deck and converts the open session, unsaved edits included", async () => {
		const item = file("deck.pptx")
		const deck = session(Uint8Array.of(1, 2, 3, 4))

		renderMenu({ item, format: "pptx", session: deck })
		await openDownloadAs()

		expect(screen.queryByRole("menuitem", { name: "PowerPoint presentation (.pptx)" })).toBeNull()

		act(() => {
			fireEvent.click(screen.getByRole("menuitem", { name: "OpenDocument presentation (.odp)" }))
		})

		expect(start).toHaveBeenCalledOnce()

		const [items, target, context] = start.mock.calls[0] as [
			DriveItem[],
			string,
			{ livePresentation: (t: "odp", s: AbortSignal) => Promise<unknown> }
		]

		expect(items).toEqual([item])
		expect(target).toBe("odp")
		await expect(context.livePresentation("odp", new AbortController().signal)).resolves.toMatchObject({ size: 4 })
	})

	it("sends the body being typed in to the deck before it converts", async () => {
		const order: string[] = []
		const deck = session(Uint8Array.of(1, 2, 3))
		const freshParts = deck.freshParts.bind(deck)

		deck.freshParts = (target, port) => {
			order.push("convert")

			return freshParts(target, port)
		}
		renderMenu({
			item: file("deck.pptx"),
			format: "pptx",
			session: deck,
			flush: () => {
				order.push("flush")

				return Promise.resolve()
			}
		})
		await openDownloadAs()
		act(() => {
			fireEvent.click(screen.getByRole("menuitem", { name: "OpenDocument presentation (.odp)" }))
		})

		const [, , context] = start.mock.calls[0] as [
			unknown,
			unknown,
			{ livePresentation: (t: "odp", s: AbortSignal) => Promise<unknown> }
		]

		await context.livePresentation("odp", new AbortController().signal)
		expect(order).toEqual(["flush", "convert"])
	})

	it("offers .pptx for an OpenDocument deck, and both for a PowerPoint 97–2003 one", async () => {
		renderMenu({ item: file("deck.odp"), format: "odp", session: session(undefined) })
		await openDownloadAs()

		expect(screen.getByRole("menuitem", { name: "PowerPoint presentation (.pptx)" })).toBeTruthy()
		expect(screen.queryByRole("menuitem", { name: "OpenDocument presentation (.odp)" })).toBeNull()
		cleanup()

		renderMenu({ item: file("deck.ppt"), format: "ppt", session: session(undefined) })
		await openDownloadAs()

		expect(screen.getByRole("menuitem", { name: "PowerPoint presentation (.pptx)" })).toBeTruthy()
		expect(screen.getByRole("menuitem", { name: "OpenDocument presentation (.odp)" })).toBeTruthy()
	})

	it("offers no Download as where the file may not be downloaded", async () => {
		renderMenu({ item: file("deck.pptx"), format: "pptx", session: session(undefined), downloads: false, copy: true, gate: [] })
		await openMenu()

		expect(screen.queryByRole("menuitem", { name: "Download as" })).toBeNull()
	})

	it("offers Save a copy only for a deck viewed for what it is, and only where a copy may be saved", async () => {
		renderMenu({ item: file("deck.pptx"), format: "pptx", session: session(undefined), gate: ["strict"] })
		await openMenu()
		expect(screen.queryByRole("menuitem", { name: "Save a copy as .pptx" })).toBeNull()
		cleanup()

		renderMenu({ item: file("deck.pptx"), format: "pptx", session: session(undefined), gate: [], copy: true })
		await openMenu()
		expect(screen.queryByRole("menuitem", { name: "Save a copy as .pptx" })).toBeNull()
		cleanup()

		// A damaged deck's copy would carry the damage.
		renderMenu({ item: file("deck.pptx"), format: "pptx", session: session(undefined), gate: ["malformed"], copy: true })
		await openMenu()
		expect(screen.queryByRole("menuitem", { name: "Save a copy as .pptx" })).toBeNull()
		cleanup()

		for (const gate of ["strict", "signed", "writeProtected"] as const) {
			renderMenu({ item: file("deck.pptx"), format: "pptx", session: session(undefined), gate: [gate], copy: true, downloads: false })
			await openMenu()
			expect(screen.getByRole("menuitem", { name: "Save a copy as .pptx" }), gate).toBeTruthy()
			cleanup()
		}
	})

	it("disables Save a copy offline: the copy is uploaded", async () => {
		online.current = false
		renderMenu({ item: file("deck.pptx"), format: "pptx", session: session(undefined), gate: ["strict"], copy: true })
		await openMenu()

		expect(screen.getByRole("menuitem", { name: "Save a copy as .pptx" }).getAttribute("aria-disabled")).toBe("true")
	})

	it("saves a Strict deck's Transitional copy beside it and says what it holds, opening it only from the dialog", async () => {
		const opened: DriveItem[] = []
		const bytes = Uint8Array.of(0x50, 0x4b, 3, 4, 5)

		renderMenu({
			item: file("deck.pptx"),
			format: "pptx",
			session: session(bytes, [{ kind: "signature", count: 1 }]),
			gate: ["strict", "signed"],
			copy: true,
			encrypted: true,
			opened
		})
		await openMenu()

		act(() => {
			fireEvent.click(screen.getByRole("menuitem", { name: "Save a copy as .pptx" }))
		})

		const dialog = await screen.findByRole("alertdialog", { name: "Saved as deck.pptx" })

		expect(uploads).toEqual([{ bytes, extension: "pptx" }])
		expect(toasts.loading).toEqual(["Saving a copy…"])
		expect(dialog.textContent).toContain("The copy is protected with the same password.")
		expect(
			within(dialog)
				.getAllByRole("listitem")
				.map(entry => entry.textContent)
		).toEqual(["Its digital signature, which a new file can't keep"])
		expect(opened).toEqual([])

		fireEvent.click(within(dialog).getByRole("button", { name: "Open the copy" }))

		await waitFor(() => {
			expect(screen.queryByRole("alertdialog")).toBeNull()
		})
		expect(opened).toHaveLength(1)
	})

	it("shows the dialog for a copy that holds the whole deck too, never opening it by itself", async () => {
		const opened: DriveItem[] = []

		renderMenu({
			item: file("deck.pptx"),
			format: "pptx",
			session: session(Uint8Array.of(1, 2, 3)),
			gate: ["writeProtected"],
			copy: true,
			opened
		})
		await openMenu()
		act(() => {
			fireEvent.click(screen.getByRole("menuitem", { name: "Save a copy as .pptx" }))
		})

		const dialog = await screen.findByRole("alertdialog", { name: "Saved as deck.pptx" })

		expect(dialog.textContent).toContain("The copy can be edited here. This file stays as it is.")
		expect(within(dialog).queryAllByRole("listitem")).toEqual([])
		expect(toasts.success).toEqual([])
		expect(opened).toEqual([])
	})

	it("says so when the copy could not be written, and uploads nothing", async () => {
		renderMenu({ item: file("deck.pptx"), format: "pptx", session: session(undefined), gate: ["strict"], copy: true })
		await openMenu()
		act(() => {
			fireEvent.click(screen.getByRole("menuitem", { name: "Save a copy as .pptx" }))
		})

		await waitFor(() => {
			expect(toasts.error).toEqual(["A copy of this presentation could not be saved"])
		})
		expect(uploads).toEqual([])
		expect(screen.queryByRole("alertdialog")).toBeNull()
	})
})

describe("the viewer's Download as", () => {
	// A public link's page downloads the file through its own button: the viewer has no host Download, only the
	// conversions of the deck it shows.
	function renderViewerMenu(downloadable: boolean, item: DriveItem, deck: PresentationSessionApi): void {
		render(
			<PreviewAccessModeProvider mode="anon">
				<PreviewDownloadableProvider downloadable={downloadable}>
					<CommandFileMenu>
						<PresentationDownloadAsMenu
							item={item}
							session={deck}
						/>
					</CommandFileMenu>
				</PreviewDownloadableProvider>
			</PreviewAccessModeProvider>
		)
	}

	it("converts a public link's deck from its session, anonymously", async () => {
		const item = file("deck.odp")

		renderViewerMenu(true, item, session(Uint8Array.of(9, 8, 7)))
		await openDownloadAs()
		act(() => {
			fireEvent.click(screen.getByRole("menuitem", { name: "PowerPoint presentation (.pptx)" }))
		})

		const [items, target, context] = start.mock.calls[0] as [
			DriveItem[],
			string,
			{ accessMode: string; livePresentation: (t: "pptx", s: AbortSignal) => Promise<unknown> }
		]

		expect(items).toEqual([item])
		expect(target).toBe("pptx")
		expect(context.accessMode).toBe("anon")
		await expect(context.livePresentation("pptx", new AbortController().signal)).resolves.toMatchObject({ size: 3 })
	})

	it("offers none where the link does not allow downloads", async () => {
		renderViewerMenu(false, file("deck.odp"), session(undefined))
		await openMenu()

		expect(screen.queryByRole("menuitem", { name: "Download as" })).toBeNull()
	})
})

describe("the PowerPoint 97–2003 bar's Save as .odp", () => {
	it("saves an OpenDocument copy beside the deck and lists what it holds differently, opened only from there", async () => {
		const opened: DriveItem[] = []
		const item = file("deck.ppt")
		const bytes = Uint8Array.of(0x50, 0x4b, 3, 4, 9)

		render(
			<LegacyPresentationBar
				format="ppt"
				saveCopy={{
					item,
					session: session(bytes, [
						{ kind: "macros", count: 1 },
						{ kind: "smartArt", count: 2 }
					]),
					encrypted: false,
					onOpenFile: copy => opened.push(copy)
				}}
			/>
		)
		fireEvent.click(screen.getByRole("button", { name: "Save as .odp" }))

		const confirm = await screen.findByRole("alertdialog", { name: "Save as .odp?" })

		expect(confirm.textContent).not.toContain("password")
		fireEvent.click(within(confirm).getByRole("button", { name: "Save as .odp" }))

		const list = await screen.findByRole("alertdialog", { name: "Saved as deck.odp" })

		expect(
			within(list)
				.getAllByRole("listitem")
				.map(entry => entry.textContent)
		).toEqual(["Its macros, which the copy can't hold", "2 SmartArt diagrams, kept as groups of shapes"])
		expect(uploads).toEqual([{ bytes, extension: "odp" }])
		expect(opened).toEqual([])
	})

	it("opens a copy that holds everything at once", async () => {
		const opened: DriveItem[] = []

		render(
			<LegacyPresentationBar
				format="ppt"
				saveCopy={{
					item: file("deck.ppt"),
					session: session(Uint8Array.of(1, 2, 3)),
					encrypted: false,
					onOpenFile: copy => opened.push(copy)
				}}
			/>
		)
		fireEvent.click(screen.getByRole("button", { name: "Save as .odp" }))
		fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Save as .odp" }))

		await waitFor(() => {
			expect(opened).toHaveLength(1)
		})
		expect(toasts.success).toEqual(["Saved as deck.odp"])
	})

	it("does not offer .odp for a deck opened with its password: the copy could not keep it", () => {
		render(
			<LegacyPresentationBar
				format="ppt"
				saveCopy={{ item: file("deck.ppt"), session: session(undefined), encrypted: true }}
			/>
		)

		expect(screen.getByRole("button", { name: "Save as .pptx" })).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Save as .odp" })).toBeNull()
	})

	it("says so when the copy could not be written", async () => {
		render(
			<LegacyPresentationBar
				format="ppt"
				saveCopy={{ item: file("deck.ppt"), session: session(undefined), encrypted: false }}
			/>
		)
		fireEvent.click(screen.getByRole("button", { name: "Save as .odp" }))
		fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Save as .odp" }))

		await waitFor(() => {
			expect(toasts.error).toEqual(["This presentation could not be saved as .odp"])
		})
		expect(uploads).toEqual([])
	})
})
