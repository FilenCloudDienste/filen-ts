// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"
import { mockViewportHeight } from "@/tests/support/viewport"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { onlineManager, QueryClientProvider } from "@tanstack/react-query"
import type { AnyFile, EntryAccess, EntryDownloadPhase } from "@filen/sdk-rs"
import type { ByteOrigin, OriginAccess } from "@/lib/sdk/byteOrigin"
import type { EntryReaderEvents } from "@/workers/originSource"
import type { EntryReadPlan } from "@/lib/sdk/archiveListing"
import type { ArchiveNameInfo } from "@/workers/sdk.worker"
import "@/lib/i18n"

// One entry of the browser on its own: Enter or a double-click previews it where it can and saves it
// otherwise, a solid 7z entry's cost is confirmed first, an encrypted one asks for the password, and a
// file row's menu offers what the entry allows.

const { openListingSession, runEntryDownload, loadEntryBytes, archiveEntryAccess } = vi.hoisted(() => ({
	openListingSession: vi.fn(),
	archiveEntryAccess: vi.fn<(readerId: string, entry: unknown, token: string) => Promise<string>>(),
	runEntryDownload: vi.fn(),
	loadEntryBytes: vi.fn()
}))

// The SDK worker's entry readers, as far as a preview reads them: each whole read goes to loadEntryBytes, which
// answers with the bytes and whether their checksum matched, and the reader's events hear its phases and outcome.
vi.mock("@/lib/sdk/client", async () => {
	const { asErrorDTO } = await import("@/lib/sdk/errors")
	const readers = new Map<string, { archive: AnyFile; password: string | undefined }>()
	const leases = new Map<string, { readerId: string; plan: EntryReadPlan; events: EntryReaderEvents }>()

	return {
		sdkApi: {
			cancelPreviewDownload: vi.fn(() => Promise.resolve()),
			openArchiveReader: (id: string, archive: AnyFile, _anon: boolean, password: string | undefined) => {
				readers.set(id, { archive, password })

				return Promise.resolve()
			},
			closeArchiveReader: (id: string) => {
				readers.delete(id)

				return Promise.resolve()
			},
			archiveReaderHeldBytes: () => Promise.resolve(0),
			archiveEntryAccess,
			leaseArchiveEntry: (id: string, readerId: string, plan: EntryReadPlan, events: EntryReaderEvents) => {
				leases.set(id, { readerId, plan, events })

				return Promise.resolve()
			},
			releaseArchiveEntry: (id: string) => {
				leases.delete(id)

				return Promise.resolve()
			},
			downloadOriginBytes: async (origin: ByteOrigin, _access: OriginAccess, _cap: number, token: string): Promise<Uint8Array> => {
				const lease = origin.kind === "entry" ? leases.get(origin.reader) : undefined
				const reader = lease === undefined ? undefined : readers.get(lease.readerId)

				if (origin.kind !== "entry" || lease === undefined || reader === undefined) {
					throw new Error("archive reader is closed")
				}

				const request = {
					params: { archive: reader.archive, entry: origin.entry, maxSolidSkip: lease.plan.maxSolidSkip },
					size: origin.size
				}

				try {
					const { bytes, checked } = (await loadEntryBytes(request, reader.password, token, (phase: EntryDownloadPhase) => {
						lease.events.phase(phase)
					})) as { bytes: Uint8Array; checked: boolean }

					if (checked) {
						lease.events.verified()
					}

					return bytes
				} catch (e) {
					lease.events.failed(asErrorDTO(e))

					throw e
				}
			}
		}
	}
})
vi.mock("@/queries/client", async () => {
	const { QueryClient: Client } = await import("@tanstack/react-query")
	return { queryClient: new Client({ defaultOptions: { queries: { retry: false } } }) }
})
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), custom: vi.fn(), dismiss: vi.fn() } }))
vi.mock("@/features/transfers/lib/archiveToast", () => ({ startExtractWithCard: vi.fn(() => "job") }))
vi.mock("@/features/archive/lib/listingSession", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/archive/lib/listingSession")>()),
	openListingSession
}))
vi.mock("@/features/archive/lib/entryDownload", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/archive/lib/entryDownload")>()),
	runEntryDownload
}))
vi.mock("@/features/drive/lib/saveDownload", async importOriginal => ({
	...(await importOriginal<typeof import("@/features/drive/lib/saveDownload")>()),
	isFsaAvailable: () => true
}))
// The viewers themselves are the preview's; this one shows what usePreviewBytes read.
vi.mock("@/features/preview/components/readOnlyPreviewBody", async () => {
	const { usePreviewBytes } = await import("@/features/preview/hooks/usePreviewBytes")

	return {
		ReadOnlyPreviewBody: ({ item, category }: { item: Parameters<typeof usePreviewBytes>[0]; category: string }) => {
			const result = usePreviewBytes(item)

			return <p>{`${category}: ${result.status === "success" ? new TextDecoder().decode(result.bytes) : result.status}`}</p>
		}
	}
})

import { queryClient } from "@/queries/client"
import type { EntryStore } from "@/features/archive/lib/entryStore"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import type { ListingSession, ListingSnapshot, ListSummary } from "@/features/archive/lib/listingSession"
import { ArchiveSourceBrowser } from "@/features/archive/components/archiveBrowser"
import { PreviewDownloadableProvider } from "@/features/preview/lib/accessMode"
import { clearPreviewCache } from "@/features/preview/lib/previewCache"
import { isTextEditingTarget } from "@/features/preview/components/previewOverlay.logic"
import { storeOf, TEST_ARCHIVE, type EntrySpec } from "@/tests/support/archiveEntries"
import { withCode } from "@/tests/support/keys"

const SUMMARY: ListSummary = {
	format: { type: "sevenZ" },
	password: "notNeeded",
	totals: { entries: 0, dirs: 0, files: 0, bytes: 0, skipped: 0, bytesSkipped: 0 },
	undelivered: 0,
	duplicates: null,
	unaccountedBytes: 0,
	verifying: false,
	verifyWaiting: false,
	verifyError: null
}

const INFO: ArchiveNameInfo = { format: { type: "sevenZ" }, defaultName: "bundle" }

const SOURCE: ArchiveSource = {
	file: { uuid: TEST_ARCHIVE } as unknown as AnyFile,
	uuid: TEST_ARCHIVE,
	name: "bundle.7z",
	size: 10 * 1024 * 1024,
	anon: false,
	nested: null,
	ownParent: null
}

const DIRECT: EntryAccess = { type: "direct", packedBytes: 3n }
const MiB = 1024 * 1024

function fakeSession(store: EntryStore, password?: string): ListingSession & { acceptPassword: Mock<(password: string) => void> } {
	const snapshot: ListingSnapshot = { phase: { type: "done", summary: SUMMARY }, store, version: 0, info: INFO }
	let costAccepted = false

	return {
		costAccepted: () => costAccepted,
		acceptCost: () => {
			costAccepted = true
		},
		getSnapshot: () => snapshot,
		subscribe: () => () => undefined,
		start: vi.fn(),
		stop: vi.fn(),
		retry: vi.fn(),
		submitPassword: vi.fn(),
		acceptPassword: vi.fn<(password: string) => void>(),
		rememberDirPath: vi.fn(),
		dispose: vi.fn(),
		password: () => password,
		restoredDirPath: () => ""
	}
}

function mockListViewport(): void {
	mockViewportHeight(element => element.getAttribute("role") === "listbox", 360)
}

const overlayStep = vi.fn<(key: string) => void>()

function show(specs: EntrySpec[], options: { downloadable?: boolean; password?: string } = {}) {
	const session = fakeSession(storeOf(specs), options.password)

	openListingSession.mockReturnValue(session)
	renderBrowser(SOURCE, options.downloadable)

	return session
}

function renderBrowser(source: ArchiveSource = SOURCE, downloadable?: boolean): void {
	render(
		<QueryClientProvider client={queryClient}>
			<PreviewDownloadableProvider downloadable={downloadable ?? true}>
				{/* Stands in for the overlay's own handler: it pages on Left/Right unless a preview surface has them. */}
				<div
					onKeyDown={event => {
						if (!isTextEditingTarget(event.target) && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
							overlayStep(event.key)
						}
					}}
				>
					<ArchiveSourceBrowser source={source} />
				</div>
			</PreviewDownloadableProvider>
		</QueryClientProvider>
	)
}

// The entry viewer's own root: the surface the overlay leaves its keys to.
function viewerRoot(inside: HTMLElement): HTMLElement {
	const root = inside.closest<HTMLElement>("[data-preview-surface]")

	if (root === null) {
		throw new Error("no viewer root")
	}

	expect(root.tabIndex).toBe(-1)

	return root
}

function list(): HTMLElement {
	return screen.getByRole("listbox")
}

function row(name: string): HTMLElement {
	const found = within(list())
		.getAllByRole("option")
		.find(option => option.textContent.includes(name))

	if (found === undefined) {
		throw new Error(`no row ${name}`)
	}

	return found
}

function press(key: string): void {
	act(() => {
		fireEvent.keyDown(list(), withCode({ key }))
	})
}

beforeEach(() => {
	mockListViewport()
	onlineManager.setOnline(true)
	clearPreviewCache()
	runEntryDownload.mockResolvedValue({ status: "success" })
	loadEntryBytes.mockResolvedValue({ bytes: new TextEncoder().encode("hi!"), checked: true })
	archiveEntryAccess.mockResolvedValue("whole")
})

afterEach(() => {
	cleanup()
	vi.clearAllMocks()
})

describe("an archive entry on its own", () => {
	it("previews a document on Enter and goes back to the list on Escape", async () => {
		show([
			{ path: "readme.md", size: 3, access: DIRECT },
			{ path: "z.bin", size: 3, access: DIRECT }
		])

		press("ArrowDown")
		press("Enter")

		expect(await screen.findByText("markdown: hi!")).toBeTruthy()
		expect(loadEntryBytes).toHaveBeenCalledWith(
			{ params: { archive: SOURCE.file, entry: { archive: TEST_ARCHIVE, index: 0 }, maxSolidSkip: 0 }, size: 3 },
			undefined,
			expect.any(String),
			expect.any(Function)
		)
		expect(runEntryDownload).not.toHaveBeenCalled()

		const back = screen.getByRole("button", { name: "Back to the archive" })

		expect(document.activeElement).toBe(back)

		act(() => {
			fireEvent.keyDown(back, withCode({ key: "Escape" }))
		})

		expect(screen.getByRole("listbox")).toBeTruthy()
	})

	it("saves an entry that doesn't preview on a double-click", () => {
		show([{ path: "z.bin", size: 3, access: DIRECT }])

		fireEvent.doubleClick(row("z.bin"))

		expect(runEntryDownload).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ password: undefined }))
		expect(runEntryDownload.mock.calls[0]?.[1]).toMatchObject({ request: { name: "z.bin", params: { maxSolidSkip: 0 } } })
	})

	it("only toggles a tar's member, which reads front to back", () => {
		show([{ path: "readme.md", size: 3, access: { type: "sequential" } }])

		press("ArrowDown")
		press("Enter")

		expect(row("readme.md").getAttribute("aria-selected")).toBe("true")
		expect(loadEntryBytes).not.toHaveBeenCalled()
		expect(runEntryDownload).not.toHaveBeenCalled()
	})

	it("confirms what a solid entry reads first, then allows exactly that skip", async () => {
		show([
			{
				path: "readme.md",
				size: 3,
				access: {
					type: "solidBlock",
					skippedBytes: BigInt(5 * MiB),
					estimatedPackedBytes: BigInt(2 * MiB),
					blockPackedBytes: BigInt(9 * MiB)
				}
			}
		])

		press("ArrowDown")
		press("Enter")

		const dialog = await screen.findByRole("alertdialog")

		// One file: nothing to read ahead, so what it fetches is its own estimate.
		expect(dialog.textContent).toMatch(/downloads about 2(\.0)? MiB of it and unpacks 5(\.0)? MiB/)
		expect(dialog.textContent).toContain("You won't be asked again while this archive is open.")
		expect(loadEntryBytes).not.toHaveBeenCalled()

		fireEvent.click(within(dialog).getByRole("button", { name: "Open" }))

		expect(await screen.findByText("markdown: hi!")).toBeTruthy()
		expect(loadEntryBytes.mock.calls[0]?.[0]).toMatchObject({ params: { maxSolidSkip: 5 * MiB } })
	})

	it("shows a file of a solid block above 512 MiB as the card offering to extract: no cost dialog, nothing read", async () => {
		const { toast } = await import("sonner")

		show([
			{
				path: "deep.md",
				size: 3,
				access: {
					type: "solidBlock",
					skippedBytes: BigInt(5 * MiB),
					estimatedPackedBytes: BigInt(6 * MiB),
					blockPackedBytes: BigInt(513 * MiB)
				}
			}
		])

		fireEvent.doubleClick(row("deep.md"))

		expect(await screen.findByText(/Extract the archive to read it/)).toBeTruthy()
		expect(screen.getByRole("button", { name: "Extract to read" })).toBeTruthy()
		expect(toast.error).not.toHaveBeenCalled()
		expect(screen.queryByRole("alertdialog")).toBeNull()
		expect(loadEntryBytes).not.toHaveBeenCalled()
		expect(runEntryDownload).not.toHaveBeenCalled()
	})

	it("asks once per listing session: a later solid entry opens unasked, still bounded by its own skip", async () => {
		const solid = (skipped: number) =>
			({
				type: "solidBlock",
				skippedBytes: BigInt(skipped),
				estimatedPackedBytes: BigInt(skipped + MiB),
				blockPackedBytes: BigInt(9 * MiB)
			}) as const

		show([
			{ path: "a.md", size: 3, access: solid(MiB) },
			{ path: "b.md", size: 3, access: solid(4 * MiB) }
		])

		fireEvent.doubleClick(row("a.md"))
		fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Open" }))
		expect(await screen.findByText("markdown: hi!")).toBeTruthy()

		act(() => {
			fireEvent.keyDown(screen.getByRole("button", { name: "Back to the archive" }), withCode({ key: "Escape" }))
		})
		fireEvent.doubleClick(row("b.md"))

		expect(await screen.findByText("markdown: hi!")).toBeTruthy()
		expect(screen.queryByRole("alertdialog")).toBeNull()
		expect(loadEntryBytes.mock.calls.map(([request]) => (request as { params: { maxSolidSkip: number } }).params.maxSolidSkip)).toEqual(
			[MiB, 4 * MiB]
		)
	})

	it("asks an encrypted entry's password before saving, and gives the listing one that worked", async () => {
		const session = show([{ path: "z.bin", size: 3, access: DIRECT, encrypted: true }])

		fireEvent.doubleClick(row("z.bin"))

		const field = await screen.findByLabelText("Password")

		expect(runEntryDownload).not.toHaveBeenCalled()

		fireEvent.change(field, { target: { value: "secret" } })
		fireEvent.click(screen.getByRole("button", { name: "Unlock" }))

		expect(runEntryDownload.mock.calls[0]?.[1]).toMatchObject({ password: "secret" })

		const args = runEntryDownload.mock.calls[0]?.[1] as { onVerified: () => void }

		args.onVerified()

		expect(session.acceptPassword).toHaveBeenCalledWith("secret")
	})

	it("asks again when the SDK refuses the password", async () => {
		runEntryDownload.mockResolvedValue({ status: "password", wrong: true })
		show([{ path: "z.bin", size: 3, access: DIRECT }], { password: "old" })

		fireEvent.doubleClick(row("z.bin"))

		expect(await screen.findByText("That password didn't open “z.bin”. Try again.")).toBeTruthy()
	})

	it("says when another archive job holds the slot", async () => {
		loadEntryBytes.mockImplementation((_request: unknown, _password: unknown, _token: unknown, onPhase: (phase: string) => void) => {
			onPhase("waitingForWorker")

			return new Promise(() => undefined)
		})
		show([{ path: "notes.txt", size: 3, access: DIRECT }])

		press("ArrowDown")
		press("Enter")

		expect(await screen.findByText("Waiting for another archive job")).toBeTruthy()
	})

	it("offers Open, Download and Extract in a file row's menu, and no Download where the link allows none", async () => {
		show([{ path: "readme.md", size: 3, access: DIRECT }])

		fireEvent.click(within(row("readme.md")).getByRole("button", { name: "More actions" }))

		expect(await screen.findByRole("menuitem", { name: "Open" })).toBeTruthy()
		expect(screen.getByRole("menuitem", { name: "Download" })).toBeTruthy()
		expect(screen.getByRole("menuitem", { name: "Extract" })).toBeTruthy()

		fireEvent.click(screen.getByRole("menuitem", { name: "Download" }))

		expect(runEntryDownload).toHaveBeenCalledOnce()

		cleanup()
		show([{ path: "readme.md", size: 3, access: DIRECT }], { downloadable: false })

		fireEvent.click(within(row("readme.md")).getByRole("button", { name: "More actions" }))

		expect(await screen.findByRole("menuitem", { name: "Open" })).toBeTruthy()
		expect(screen.queryByRole("menuitem", { name: "Download" })).toBeNull()
	})

	it("offers a file row's ⋯ items on a right-click, selecting the row first", async () => {
		show([
			{ path: "readme.md", size: 3, access: DIRECT },
			{ path: "z.bin", size: 3, access: DIRECT }
		])

		const readme = row("readme.md")
		const zbin = row("z.bin")

		fireEvent.click(zbin, { detail: 1 })
		fireEvent.contextMenu(within(readme).getByText("readme.md"))

		expect(await screen.findByRole("menuitem", { name: "Open" })).toBeTruthy()
		expect(screen.getByRole("menuitem", { name: "Download" })).toBeTruthy()
		expect(screen.getByRole("menuitem", { name: "Extract" })).toBeTruthy()
		expect(readme.getAttribute("aria-selected")).toBe("true")
		expect(zbin.getAttribute("aria-selected")).toBe("false")

		fireEvent.click(screen.getByRole("menuitem", { name: "Download" }))

		expect(runEntryDownload.mock.calls[0]?.[1]).toMatchObject({ request: { name: "readme.md" } })
	})

	it("offers the selection's Extract alone on a right-click inside a selection of several", async () => {
		show([
			{ path: "readme.md", size: 3, access: DIRECT },
			{ path: "z.bin", size: 3, access: DIRECT }
		])

		const readme = row("readme.md")
		const zbin = row("z.bin")

		fireEvent.click(readme, { detail: 1 })
		fireEvent.click(zbin, { detail: 1, ctrlKey: true })
		fireEvent.contextMenu(zbin)

		expect(await screen.findByRole("menuitem", { name: "Extract" })).toBeTruthy()
		expect(screen.queryByRole("menuitem", { name: "Open" })).toBeNull()
		expect(screen.queryByRole("menuitem", { name: "Download" })).toBeNull()
		expect(readme.getAttribute("aria-selected")).toBe("true")
		expect(zbin.getAttribute("aria-selected")).toBe("true")
	})

	it("offers a directory's Open and Extract, and opens it", async () => {
		show([{ path: "docs/a.txt", size: 3, access: DIRECT }])

		const docs = row("docs")

		fireEvent.contextMenu(docs)

		expect(await screen.findByRole("menuitem", { name: "Extract" })).toBeTruthy()
		expect(docs.getAttribute("aria-selected")).toBe("true")

		await act(async () => {
			fireEvent.click(screen.getByRole("menuitem", { name: "Open" }))
			await Promise.resolve()
		})

		expect(screen.getByRole("button", { name: "docs" }).getAttribute("aria-current")).toBe("location")
	})

	it("opens no menu on a row with nothing to offer, or on the list's empty space", () => {
		show([
			{ path: "z.bin", size: 3, access: DIRECT },
			{ path: "dev", kind: { type: "device" }, skip: "device" }
		])

		fireEvent.click(row("z.bin"), { detail: 1 })
		fireEvent.contextMenu(row("dev"))
		fireEvent.contextMenu(list())

		expect(screen.queryByRole("menu")).toBeNull()
		expect(row("z.bin").getAttribute("aria-selected")).toBe("true")
	})

	// The Menu key raises a pointer-less contextmenu on the focused listbox, which names its cursor by
	// aria-activedescendant.
	function keyboardMenu(): void {
		act(() => {
			list().dispatchEvent(new PointerEvent("contextmenu", { bubbles: true, cancelable: true, pointerType: "" }))
		})
	}

	it("opens the cursor row's menu from the Menu key, raised at the row, and none before a cursor", async () => {
		show([
			{ path: "readme.md", size: 3, access: DIRECT },
			{ path: "z.bin", size: 3, access: DIRECT }
		])

		keyboardMenu()
		expect(screen.queryByRole("menu")).toBeNull()

		const raised = vi.fn<(target: EventTarget | null) => void>()
		// Taken now: the open menu hides the list from the accessible tree.
		const readme = row("readme.md")
		const zbin = row("z.bin")

		list().addEventListener("contextmenu", event => {
			raised(event.target)
		})
		press("ArrowDown")
		press("ArrowDown")
		keyboardMenu()

		expect(await screen.findByRole("menuitem", { name: "Download" })).toBeTruthy()
		expect(raised).toHaveBeenLastCalledWith(zbin)
		expect(zbin.getAttribute("aria-selected")).toBe("true")
		expect(readme.getAttribute("aria-selected")).toBe("false")
	})

	it("opens the cursor row's menu on Shift+F10, a directory's included", async () => {
		show([
			{ path: "docs/a.txt", size: 3, access: DIRECT },
			{ path: "z.bin", size: 3, access: DIRECT }
		])

		const docs = row("docs")

		press("ArrowDown")
		act(() => {
			fireEvent.keyDown(list(), withCode({ key: "F10", shiftKey: true }))
		})

		expect(await screen.findByRole("menuitem", { name: "Extract" })).toBeTruthy()
		expect(screen.getByRole("menuitem", { name: "Open" })).toBeTruthy()
		expect(docs.getAttribute("aria-selected")).toBe("true")
	})

	it("offers no extract on an entry's card where the link allows no downloads", async () => {
		show(
			[
				{
					path: "deep.md",
					size: 3,
					access: {
						type: "solidBlock",
						skippedBytes: BigInt(5 * MiB),
						estimatedPackedBytes: BigInt(6 * MiB),
						blockPackedBytes: BigInt(513 * MiB)
					}
				},
				{ path: "film.mp4", size: 100 * MiB, access: DIRECT }
			],
			{ downloadable: false }
		)

		fireEvent.doubleClick(row("deep.md"))
		expect(await screen.findByText(/Extract the archive to read it/)).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Extract to read" })).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: /Back/ }))
		fireEvent.doubleClick(row("film.mp4"))
		expect(await screen.findByText(/Extract the archive to play it/)).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Extract to play" })).toBeNull()
	})

	it("shows why an entry's access could not be told, and asks again on Try again", async () => {
		archiveEntryAccess.mockRejectedValueOnce(new Error("network down"))
		show([{ path: "film.mp4", size: 100 * MiB, access: DIRECT }])

		fireEvent.doubleClick(row("film.mp4"))
		fireEvent.click(await screen.findByRole("button", { name: "Try again" }))
		expect(await screen.findByText(/Extract the archive to play it/)).toBeTruthy()
		expect(archiveEntryAccess).toHaveBeenCalledTimes(2)
	})

	it("asks how an entry reads before its content read when that read may find media", async () => {
		show([{ path: "song.mod", size: 100 * MiB, access: DIRECT }])

		fireEvent.doubleClick(row("song.mod"))
		await vi.waitFor(() => {
			expect(archiveEntryAccess).toHaveBeenCalledTimes(1)
		})
	})

	it("cancels an entry's access question when the viewer goes", async () => {
		const { sdkApi } = await import("@/lib/sdk/client")

		archiveEntryAccess.mockReturnValueOnce(new Promise(() => undefined))
		show([{ path: "film.mp4", size: 100 * MiB, access: DIRECT }])

		fireEvent.doubleClick(row("film.mp4"))
		await vi.waitFor(() => {
			expect(archiveEntryAccess).toHaveBeenCalledTimes(1)
		})

		const token = archiveEntryAccess.mock.calls[0]?.[2]

		fireEvent.click(screen.getByRole("button", { name: /Back/ }))
		expect(sdkApi.cancelPreviewDownload).toHaveBeenCalledWith(token)
	})

	it("browses an archive held in a stored entry in its place, crumbs running on through it, and leaves it again", async () => {
		const outer = fakeSession(storeOf([{ path: "trip/inner.zip", size: 3 * MiB, access: DIRECT }]))
		const inner = fakeSession(storeOf([{ path: "day1/photo.txt", size: 3, access: DIRECT }]))
		const opened: ArchiveSource[] = []

		archiveEntryAccess.mockResolvedValue("mapped")
		openListingSession.mockImplementation((source: ArchiveSource) => {
			opened.push(source)

			return source.nested === null ? outer : inner
		})
		renderBrowser()

		fireEvent.doubleClick(row("trip"))
		fireEvent.doubleClick(row("inner.zip"))
		expect(await screen.findByRole("listbox", { name: /inner\.zip/ })).toBeTruthy()

		const nested = opened.at(-1)

		expect(nested?.nested).toMatchObject({ index: 0, depth: 2 })
		expect(nested?.uuid).toBe(`${TEST_ARCHIVE}/0`)

		const crumbs = screen.getByRole("navigation", { name: "Location in the archive" })

		expect(
			within(crumbs)
				.getAllByRole("button")
				.map(button => button.textContent)
		).toEqual(["bundle.7z", "trip", "inner.zip"])
		expect(crumbs.querySelector("[data-archive-boundary]")).not.toBeNull()
		// Nothing is extracted from an archive held in another.
		expect(screen.getByText("This archive is inside another. Extract the outer archive to get its files.")).toBeTruthy()

		fireEvent.click(within(crumbs).getByRole("button", { name: "trip" }))
		expect(await screen.findByRole("listbox", { name: /trip/ })).toBeTruthy()
		expect(row("inner.zip")).toBeTruthy()
	})

	it("shows an archive held in an entry read only whole as the card offering to extract the outer one", async () => {
		show([{ path: "inner.tar.gz", size: 3 * MiB, access: DIRECT }])
		archiveEntryAccess.mockResolvedValue("whole")

		fireEvent.doubleClick(row("inner.tar.gz"))
		expect(await screen.findByText(/can't be opened from inside this archive/)).toBeTruthy()
		expect(screen.getByRole("button", { name: "Extract to open" })).toBeTruthy()
	})

	it("confirms unpacking a large archive held in a compressed entry before browsing it", async () => {
		const outer = fakeSession(storeOf([{ path: "big.zip", size: 300 * MiB, access: DIRECT }]))
		const inner = fakeSession(storeOf([{ path: "a.txt", size: 3, access: DIRECT }]))

		archiveEntryAccess.mockResolvedValue("seekable")
		openListingSession.mockImplementation((source: ArchiveSource) => (source.nested === null ? outer : inner))
		renderBrowser()

		fireEvent.doubleClick(row("big.zip"))

		const dialog = await screen.findByRole("alertdialog", { name: "Unpack this archive first?" })

		expect(dialog.textContent).toContain("300 MiB")
		fireEvent.click(within(dialog).getByRole("button", { name: "Browse" }))
		expect(await screen.findByRole("listbox", { name: /big\.zip/ })).toBeTruthy()
	})

	it("offers no open for an archive three deep", () => {
		const deep: ArchiveSource = {
			...SOURCE,
			uuid: `${TEST_ARCHIVE}/0/1`,
			nested: {
				parent: { ...SOURCE, uuid: `${TEST_ARCHIVE}/0`, nested: { parent: SOURCE, parentPassword: undefined, index: 0, depth: 2 } },
				parentPassword: undefined,
				index: 1,
				depth: 3
			}
		}

		openListingSession.mockReturnValue(fakeSession(storeOf([{ path: "inner.zip", size: 3, access: DIRECT }])))
		renderBrowser(deep)

		fireEvent.doubleClick(row("inner.zip"))
		expect(archiveEntryAccess).not.toHaveBeenCalled()
	})

	it("previews but never saves from a link that allows no downloads", async () => {
		show(
			[
				{ path: "z.bin", size: 3, access: DIRECT },
				{ path: "notes.txt", size: 3, access: DIRECT }
			],
			{ downloadable: false }
		)

		fireEvent.doubleClick(row("z.bin"))

		expect(runEntryDownload).not.toHaveBeenCalled()

		fireEvent.doubleClick(row("notes.txt"))

		expect(await screen.findByText("text: hi!")).toBeTruthy()
		expect(screen.queryByRole("button", { name: "Download" })).toBeNull()
	})
	it("keeps Left and Right from paging the overlay while an entry is open, on the viewer and inside it", async () => {
		show([{ path: "readme.md", size: 3, access: DIRECT }])

		press("ArrowDown")
		press("Enter")

		const body = await screen.findByText("markdown: hi!")
		const viewer = viewerRoot(body)

		fireEvent.keyDown(viewer, withCode({ key: "ArrowRight" }))
		fireEvent.keyDown(body, withCode({ key: "ArrowLeft" }))
		fireEvent.keyDown(screen.getByRole("button", { name: "Back to the archive" }), withCode({ key: "ArrowRight" }))

		expect(overlayStep).not.toHaveBeenCalled()
	})

	it("goes back to the list on Escape after a click into the viewer", async () => {
		show([{ path: "readme.md", size: 3, access: DIRECT }])

		press("ArrowDown")
		press("Enter")

		const body = await screen.findByText("markdown: hi!")
		const viewer = viewerRoot(body)

		// A click on what it shows focuses the viewer's root, its nearest focusable ancestor (jsdom moves no
		// focus on a click).
		fireEvent.mouseDown(body)
		act(() => {
			viewer.focus()
		})

		expect(document.activeElement).toBe(viewer)

		act(() => {
			fireEvent.keyDown(viewer, withCode({ key: "Escape" }))
		})

		expect(screen.getByRole("listbox")).toBeTruthy()
	})

	it("gives the listing only a password an entry's checksum proved", async () => {
		loadEntryBytes.mockResolvedValue({ bytes: new TextEncoder().encode("hi!"), checked: false })

		const unchecked = show([{ path: "notes.txt", size: 3, access: DIRECT, encrypted: true }], { password: "pw" })

		press("ArrowDown")
		press("Enter")

		expect(await screen.findByText("text: hi!")).toBeTruthy()
		expect(loadEntryBytes.mock.calls[0]?.[1]).toBe("pw")
		expect(unchecked.acceptPassword).not.toHaveBeenCalled()

		cleanup()
		clearPreviewCache()
		loadEntryBytes.mockResolvedValue({ bytes: new TextEncoder().encode("hi!"), checked: true })

		const checked = show([{ path: "notes.txt", size: 3, access: DIRECT, encrypted: true }], { password: "pw" })

		press("ArrowDown")
		press("Enter")

		expect(await screen.findByText("text: hi!")).toBeTruthy()
		expect(checked.acceptPassword).toHaveBeenCalledWith("pw")
	})
})
