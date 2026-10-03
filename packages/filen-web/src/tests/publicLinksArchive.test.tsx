// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, useContext, type ReactNode } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { DirPublicInfo, File as SdkFile, LinkedDirsAndFiles, UuidStr } from "@filen/sdk-rs"
import type { JobDestination } from "@filen/shared"
import type { ArchiveSource } from "@/features/archive/lib/archiveSource"
import type { ListingCache } from "@/features/archive/lib/listingCache"
import "@/lib/i18n"

// A public link's archive actions: signed-in visitors only, nothing read before a click, extracting only
// with downloads allowed, and the listings kept for as long as the link stays open.

const { hasClient, ownsItem, listLinkedDirAnon, getLinkedDirSizeAnon, extractArchiveTo, pickProps, compressProps, created, seenCaches } =
	vi.hoisted(() => ({
		hasClient: vi.fn<() => Promise<boolean>>(),
		ownsItem: vi.fn<(kind: "file" | "directory", uuid: string) => Promise<boolean>>(),
		listLinkedDirAnon: vi.fn<() => Promise<LinkedDirsAndFiles>>(),
		getLinkedDirSizeAnon: vi.fn<() => Promise<{ size: bigint; files: bigint; dirs: bigint }>>(),
		extractArchiveTo: vi.fn<(source: ArchiveSource, destination: JobDestination) => Promise<void>>(),
		pickProps: {
			current: null as null | {
				mode?: string
				startsWork?: boolean
				onPick: (destination: JobDestination) => void
				onClose: () => void
			}
		},
		compressProps: { current: null as null | { subject: unknown; onClose: () => void } },
		created: [] as { cache: ListingCache; closed: () => boolean }[],
		seenCaches: [] as (ListingCache | null)[]
	}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { hasClient, ownsItem, listLinkedDirAnon, getLinkedDirSizeAnon } }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }) }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))
vi.mock("@/features/drive/lib/archiveActions", () => ({ extractArchiveTo }))
// The picker and the compress dialog are drive's, tested on their own; here they only have to receive
// what the public page hands them.
vi.mock("@/features/drive/components/moveTargetDialog", () => ({
	MoveTargetDialog: (props: NonNullable<(typeof pickProps)["current"]>) => {
		pickProps.current = props

		return null
	}
}))
vi.mock("@/features/drive/components/compressDialog", () => ({
	CompressDialog: (props: NonNullable<(typeof compressProps)["current"]>) => {
		compressProps.current = props

		return null
	}
}))
// The browser is archive's; this one shows what the page gave it: the source, the link's flag and the
// listing cache it would reopen from.
vi.mock("@/features/archive/components/archiveBrowser", async () => {
	const { usePreviewDownloadable } = await import("@/features/preview/lib/accessMode")
	const { ListingCacheContext } = await import("@/features/archive/lib/listingCache")

	return {
		ArchiveSourceBrowser: ({ source }: { source: ArchiveSource }) => {
			const downloadable = usePreviewDownloadable()
			const cache = useContext(ListingCacheContext)

			seenCaches.push(cache)

			return createElement("p", null, `browsing ${source.name} ${downloadable ? "downloadable" : "browse-only"}`)
		}
	}
})
vi.mock("@/features/archive/lib/listingCache", async importOriginal => {
	const actual = await importOriginal<typeof import("@/features/archive/lib/listingCache")>()

	return {
		...actual,
		createListingCache: () => {
			const cache = actual.createListingCache()
			let closed = false
			const close = cache.close

			cache.close = () => {
				closed = true
				close()
			}

			created.push({ cache, closed: () => closed })

			return cache
		}
	}
})
vi.mock("@tanstack/react-router", async () => {
	const { createElement: element, forwardRef } = await import("react")

	return {
		Link: forwardRef<HTMLAnchorElement, { to: string; children?: ReactNode }>(({ to, children }, ref) =>
			element("a", { ref, href: to }, children)
		)
	}
})

import { queryClient } from "@/queries/client"
import { ArchiveListingScope } from "@/features/archive/components/archiveListingScope"
import { FileHero } from "@/features/publicLinks/components/fileHero"
import { DirectoryBrowser } from "@/features/publicLinks/components/directoryBrowser"
import { PublicLinkView } from "@/features/publicLinks/components/publicLinkView"
import { linkedFileItem, mockLinkedFile } from "@/tests/fixtures/sdk"

const ARCHIVE_UUID = "f3000000-0000-0000-0000-000000000001" as UuidStr
const DESTINATION: JobDestination = { uuid: "d3000000-0000-0000-0000-000000000001", name: "Docs" }

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient }, createElement(ArchiveListingScope, null, children))
}

async function settle(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 10; i++) {
			await new Promise(resolve => setTimeout(resolve, 0))
		}
	})
}

async function renderHero(name: string, signedIn: boolean, downloadEnabled: boolean): Promise<void> {
	hasClient.mockResolvedValue(signedIn)

	const linked = mockLinkedFile({ uuid: ARCHIVE_UUID, name: { Decrypted: name } })

	render(
		createElement(FileHero, {
			item: linkedFileItem(name, { uuid: ARCHIVE_UUID }),
			downloadEnabled,
			linkScope: "scope",
			archiveFile: linked
		}),
		{ wrapper }
	)
	await settle()
}

function queryButton(name: string): HTMLElement | null {
	return screen.queryByRole("button", { name })
}

beforeEach(() => {
	queryClient.clear()
	vi.clearAllMocks()
	ownsItem.mockResolvedValue(false)
	extractArchiveTo.mockResolvedValue(undefined)
	pickProps.current = null
	compressProps.current = null
	seenCaches.length = 0
	created.length = 0
})

afterEach(() => {
	cleanup()
})

describe("FileHero — a linked archive", () => {
	it("offers a signed-out visitor Download only", async () => {
		await renderHero("photos.zip", false, true)

		expect(queryButton("Download")).not.toBeNull()
		expect(queryButton("Browse contents")).toBeNull()
		expect(queryButton("Extract to my Cloud Drive")).toBeNull()
		expect(screen.queryByText(/^browsing/)).toBeNull()
	})

	it("never opens the archive on its own", async () => {
		await renderHero("photos.zip", true, true)

		expect(queryButton("Download")).not.toBeNull()
		expect(queryButton("Extract to my Cloud Drive")).not.toBeNull()
		expect(queryButton("Browse contents")).not.toBeNull()
		expect(screen.queryByText(/^browsing/)).toBeNull()
		expect(seenCaches).toEqual([])
	})

	it("extracts the linked file into the directory the picker returns", async () => {
		await renderHero("photos.zip", true, true)

		fireEvent.click(screen.getByRole("button", { name: "Extract to my Cloud Drive" }))

		expect(pickProps.current?.mode).toBe("pick")
		expect(pickProps.current?.startsWork).toBe(true)

		pickProps.current?.onPick(DESTINATION)

		expect(extractArchiveTo).toHaveBeenCalledTimes(1)

		const [source, destination] = extractArchiveTo.mock.calls[0] ?? []

		expect(destination).toEqual(DESTINATION)
		expect(source?.uuid).toBe(ARCHIVE_UUID)
		expect(source?.name).toBe("photos.zip")
		expect(source?.ownParent).toBeUndefined()
		expect(source?.file).toMatchObject({ uuid: ARCHIVE_UUID, linkedTag: true })
	})

	it("browses, without extracting, when the link disallows downloads", async () => {
		await renderHero("photos.zip", true, false)

		expect(queryButton("Download")).toBeNull()
		expect(queryButton("Extract to my Cloud Drive")).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Browse contents" }))

		expect(screen.getByText("browsing photos.zip browse-only")).toBeDefined()
		expect(queryButton("Extract to my Cloud Drive")).toBeNull()
	})

	it("keeps the page's listings across Hide contents and Browse contents", async () => {
		await renderHero("photos.zip", true, true)

		fireEvent.click(screen.getByRole("button", { name: "Browse contents" }))
		expect(screen.getByText("browsing photos.zip downloadable")).toBeDefined()
		// The browser's own footer extracts while it shows; a bar button would queue behind the listing.
		expect(queryButton("Extract to my Cloud Drive")).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Hide contents" }))
		expect(screen.queryByText(/^browsing/)).toBeNull()

		fireEvent.click(screen.getByRole("button", { name: "Browse contents" }))
		expect(screen.getByText("browsing photos.zip downloadable")).toBeDefined()

		const [first] = seenCaches

		expect(first).not.toBeNull()
		expect(seenCaches.every(cache => cache === first)).toBe(true)
		expect(created.every(entry => !entry.closed())).toBe(true)
	})

	it("asks nothing about the visitor for a file that isn't an archive", async () => {
		await renderHero("setup.exe", true, true)

		expect(queryButton("Browse contents")).toBeNull()
		expect(hasClient).not.toHaveBeenCalled()
	})
})

const PARENT = "00000000-0000-0000-0000-000000000000" as UuidStr

function makeFile(uuid: UuidStr, name: string): SdkFile {
	return {
		uuid,
		stableUUID: undefined,
		meta: { type: "decoded", data: { name, mime: "application/zip", size: 10n, key: "k", version: 2, modified: 1n } },
		parent: PARENT,
		size: 10n,
		favorited: false,
		region: "",
		bucket: "",
		timestamp: 1n,
		chunks: 1n,
		canMakeThumbnail: false
	}
}

function makeInfo(enableDownload: boolean): DirPublicInfo {
	return {
		root: {
			inner: {
				uuid: "e3000000-0000-0000-0000-000000000001",
				color: "default",
				timestamp: 0n,
				meta: { type: "decoded", data: { name: "Shared" } }
			},
			linkedTag: true
		},
		link: {
			linkUuid: "c3000000-0000-0000-0000-000000000001",
			linkKey: "key",
			linkKeyVersion: 2,
			password: { type: "none" },
			enableDownload,
			salt: "salt"
		},
		hasPassword: false
	}
}

async function renderDirectory(signedIn: boolean, enableDownload: boolean): Promise<DirPublicInfo> {
	const info = makeInfo(enableDownload)

	hasClient.mockResolvedValue(signedIn)
	listLinkedDirAnon.mockResolvedValue({ dirs: [], files: [makeFile(ARCHIVE_UUID, "photos.zip")] })
	getLinkedDirSizeAnon.mockResolvedValue({ size: 10n, files: 1n, dirs: 0n })
	render(createElement(DirectoryBrowser, { info, link: info.link }), { wrapper })
	await settle()

	return info
}

describe("DirectoryBrowser — a linked directory", () => {
	it("saves the directory on screen as an archive for a signed-in visitor with downloads allowed", async () => {
		const info = await renderDirectory(true, true)

		fireEvent.click(screen.getByRole("button", { name: "Save as archive" }))

		expect(compressProps.current?.subject).toEqual({
			kind: "linked",
			items: [{ dir: info.root, link: info.link }],
			naming: [{ name: "Shared", directory: true }]
		})
	})

	it("offers no archive to a signed-out visitor", async () => {
		await renderDirectory(false, true)

		expect(queryButton("Save as archive")).toBeNull()
	})

	it("offers no archive when the link disallows downloads", async () => {
		await renderDirectory(true, false)

		expect(queryButton("Save as archive")).toBeNull()
	})

	it("hands a child archive's own listing File to its hero, which reads nothing before Browse", async () => {
		await renderDirectory(true, true)

		fireEvent.click(screen.getByText("photos.zip"))
		await settle()

		fireEvent.click(screen.getByRole("button", { name: "Extract to my Cloud Drive" }))
		pickProps.current?.onPick(DESTINATION)

		expect(extractArchiveTo.mock.calls[0]?.[0].file).toMatchObject({ uuid: ARCHIVE_UUID, parent: PARENT })
		expect(seenCaches).toEqual([])
	})
})

describe("PublicLinkView", () => {
	function view(uuid: string) {
		return createElement(QueryClientProvider, { client: queryClient }, createElement(PublicLinkView, { kind: "file", uuid }))
	}

	it("drops the archive listings once the visitor leaves the link", () => {
		const rendered = render(view("b3000000-0000-0000-0000-000000000001"))

		expect(created.some(entry => !entry.closed())).toBe(true)

		rendered.unmount()

		expect(created.every(entry => entry.closed())).toBe(true)
	})

	it("drops them when the same view moves on to another link", () => {
		const rendered = render(view("b3000000-0000-0000-0000-000000000001"))
		const [first] = created.filter(entry => !entry.closed())

		rendered.rerender(view("c3000000-0000-0000-0000-000000000002"))

		expect(first?.closed()).toBe(true)
		expect(created.some(entry => entry !== first && !entry.closed())).toBe(true)
	})
})
