// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi, type Mock } from "vitest"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { onlineManager, QueryClientProvider } from "@tanstack/react-query"
import type { AnyFile, EntryAccess } from "@filen/sdk-rs"
import type { ArchiveNameInfo } from "@/workers/sdk.worker"
import "@/lib/i18n"

// One entry of the browser on its own: Enter or a double-click previews it where it can and saves it
// otherwise, a solid 7z entry's cost is confirmed first, an encrypted one asks for the password, and a
// file row's menu offers what the entry allows.

const { openListingSession, runEntryDownload, loadEntryBytes } = vi.hoisted(() => ({
	openListingSession: vi.fn(),
	runEntryDownload: vi.fn(),
	loadEntryBytes: vi.fn()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { cancelPreviewDownload: vi.fn(() => Promise.resolve()) } }))
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
	runEntryDownload,
	loadEntryBytes
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
	ownParent: null
}

const DIRECT: EntryAccess = { type: "direct", packedBytes: 3n }
const MiB = 1024 * 1024

function fakeSession(store: EntryStore, password?: string): ListingSession & { acceptPassword: Mock<(password: string) => void> } {
	const snapshot: ListingSnapshot = { phase: { type: "done", summary: SUMMARY }, store, version: 0, info: INFO }

	return {
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
	const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight")

	Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
		configurable: true,
		get(this: HTMLElement) {
			return this.getAttribute("role") === "listbox" ? 360 : 0
		}
	})
	onTestFinished(() => {
		if (original === undefined) {
			Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight")
		} else {
			Object.defineProperty(HTMLElement.prototype, "offsetHeight", original)
		}
	})
}

const overlayStep = vi.fn<(key: string) => void>()

function show(specs: EntrySpec[], options: { downloadable?: boolean; password?: string } = {}) {
	const session = fakeSession(storeOf(specs), options.password)

	openListingSession.mockReturnValue(session)
	render(
		<QueryClientProvider client={queryClient}>
			<PreviewDownloadableProvider downloadable={options.downloadable ?? true}>
				{/* Stands in for the overlay's own handler: it pages on Left/Right unless a preview surface has them. */}
				<div
					onKeyDown={event => {
						if (!isTextEditingTarget(event.target) && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
							overlayStep(event.key)
						}
					}}
				>
					<ArchiveSourceBrowser source={SOURCE} />
				</div>
			</PreviewDownloadableProvider>
		</QueryClientProvider>
	)

	return session
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
		fireEvent.keyDown(list(), { key })
	})
}

beforeEach(() => {
	mockListViewport()
	onlineManager.setOnline(true)
	clearPreviewCache()
	runEntryDownload.mockResolvedValue({ status: "success" })
	loadEntryBytes.mockResolvedValue({ bytes: new TextEncoder().encode("hi!"), checked: true })
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

		press("Enter")

		expect(await screen.findByText("markdown: hi!")).toBeTruthy()
		expect(loadEntryBytes).toHaveBeenCalledWith(
			{ params: { archive: SOURCE.file, entry: { archive: TEST_ARCHIVE, index: 0 }, maxSolidSkip: 0 }, name: "readme.md", size: 3 },
			undefined,
			expect.any(String),
			expect.any(Function)
		)
		expect(runEntryDownload).not.toHaveBeenCalled()

		const back = screen.getByRole("button", { name: "Back to the archive" })

		expect(document.activeElement).toBe(back)

		act(() => {
			fireEvent.keyDown(back, { key: "Escape" })
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

		press("Enter")

		const dialog = await screen.findByRole("alertdialog")

		expect(dialog.textContent).toMatch(/about 2(\.0)? MiB of the archive is downloaded, and 5(\.0)? MiB/)
		expect(loadEntryBytes).not.toHaveBeenCalled()

		fireEvent.click(within(dialog).getByRole("button", { name: "Open" }))

		expect(await screen.findByText("markdown: hi!")).toBeTruthy()
		expect(loadEntryBytes.mock.calls[0]?.[0]).toMatchObject({ params: { maxSolidSkip: 5 * MiB } })
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

		press("Enter")

		const body = await screen.findByText("markdown: hi!")
		const viewer = viewerRoot(body)

		fireEvent.keyDown(viewer, { key: "ArrowRight" })
		fireEvent.keyDown(body, { key: "ArrowLeft" })
		fireEvent.keyDown(screen.getByRole("button", { name: "Back to the archive" }), { key: "ArrowRight" })

		expect(overlayStep).not.toHaveBeenCalled()
	})

	it("goes back to the list on Escape after a click into the viewer", async () => {
		show([{ path: "readme.md", size: 3, access: DIRECT }])

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
			fireEvent.keyDown(viewer, { key: "Escape" })
		})

		expect(screen.getByRole("listbox")).toBeTruthy()
	})

	it("gives the listing only a password an entry's checksum proved", async () => {
		loadEntryBytes.mockResolvedValue({ bytes: new TextEncoder().encode("hi!"), checked: false })

		const unchecked = show([{ path: "notes.txt", size: 3, access: DIRECT, encrypted: true }], { password: "pw" })

		press("Enter")

		expect(await screen.findByText("text: hi!")).toBeTruthy()
		expect(loadEntryBytes.mock.calls[0]?.[1]).toBe("pw")
		expect(unchecked.acceptPassword).not.toHaveBeenCalled()

		cleanup()
		clearPreviewCache()
		loadEntryBytes.mockResolvedValue({ bytes: new TextEncoder().encode("hi!"), checked: true })

		const checked = show([{ path: "notes.txt", size: 3, access: DIRECT, encrypted: true }], { password: "pw" })

		press("Enter")

		expect(await screen.findByText("text: hi!")).toBeTruthy()
		expect(checked.acceptPassword).toHaveBeenCalledWith("pw")
	})
})
