// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createElement, type ReactNode } from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { LinkedFile } from "@filen/sdk-rs"
import "@/lib/i18n"

// A public file link whose owner disallows downloads keeps its preview but offers no way to take the
// file: no Download, no Save to Cloud Drive (a copy downloads it too), no Download in the preview a chat
// embed opens, and no download entry in a media player's native controls.

const { getLinkedFileAnon, hasClient, ownsItem } = vi.hoisted(() => ({
	getLinkedFileAnon: vi.fn<(uuid: string, key: string, password: string | undefined) => Promise<LinkedFile>>(),
	hasClient: vi.fn<() => Promise<boolean>>(),
	ownsItem: vi.fn<(kind: "file" | "directory", uuid: string) => Promise<boolean>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { getLinkedFileAnon, hasClient, ownsItem } }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } }) }))
vi.mock("@/features/transfers/lib/copyToast", () => ({ startLinkedCopyWithCard: vi.fn() }))
vi.mock("@/features/drive/components/moveTargetDialog", () => ({ MoveTargetDialog: () => null }))
vi.mock("@/features/publicLinks/lib/download", () => ({ startAnonFileDownload: vi.fn() }))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }))
vi.mock("@tanstack/react-router", () => ({
	useBlocker: () => ({ status: "idle" }),
	useNavigate: () => vi.fn(),
	useRouterState: () => "/chats"
}))
vi.mock("@/lib/keymap/useAction", () => ({ useAction: vi.fn() }))
vi.mock("@/lib/useIsOnline", () => ({ useIsOnline: () => true }))

import { queryClient } from "@/queries/client"
import { FileLinkView } from "@/features/publicLinks/components/fileLinkView"
import { MediaElement } from "@/features/preview/components/mediaViewer"
import { PreviewOverlay } from "@/features/preview/components/previewOverlay"
import { linkedFileIntoDriveItem } from "@/features/drive/lib/item"
import { mediaControlsList, PreviewDownloadableProvider } from "@/features/preview/lib/accessMode"

const LINK_UUID = "c1000000-0000-0000-0000-000000000000"

// Not previewable, so the hero card shows, with every action it can offer.
function linkedFile(downloadable: boolean): LinkedFile {
	return {
		uuid: "f1000000-0000-0000-0000-000000000000",
		name: { Decrypted: "archive.bin" },
		mime: { Decrypted: "application/octet-stream" },
		size: 10n,
		chunks: 1n,
		region: "de-1",
		bucket: "filen-1",
		version: 2,
		timestamp: 0n,
		fileKey: "k",
		downloadable,
		linkedTag: true,
		canMakeThumbnail: false
	}
}

function wrapper({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient, children })
}

async function renderLink(downloadable: boolean): Promise<void> {
	getLinkedFileAnon.mockResolvedValue(linkedFile(downloadable))
	render(createElement(FileLinkView, { uuid: LINK_UUID, linkKey: "key" }), { wrapper })

	await act(async () => {
		for (let i = 0; i < 10; i++) {
			await new Promise(resolve => setTimeout(resolve, 0))
		}
	})
}

beforeEach(() => {
	queryClient.clear()
	vi.clearAllMocks()
	// A signed-in visitor who doesn't own the link: the one who could save it.
	hasClient.mockResolvedValue(true)
	ownsItem.mockResolvedValue(false)
})

afterEach(() => {
	cleanup()
})

describe("FileLinkView — the link's downloadable flag", () => {
	it("offers Download and Save to Cloud Drive on a link that allows downloads", async () => {
		await renderLink(true)

		expect(screen.getByRole("button", { name: "Download" })).toBeDefined()
		expect(screen.getByRole("button", { name: "Save to Cloud Drive" })).toBeDefined()
		expect(screen.queryByText("The owner has disabled downloads for this link.")).toBeNull()
	})

	it("offers neither on a link that disallows them, says why, and never asks who owns it", async () => {
		await renderLink(false)

		expect(screen.getByText("archive.bin")).toBeDefined()
		expect(screen.queryByRole("button", { name: "Download" })).toBeNull()
		expect(screen.queryByRole("button", { name: "Save to Cloud Drive" })).toBeNull()
		expect(screen.getByText("The owner has disabled downloads for this link.")).toBeDefined()
		expect(ownsItem).not.toHaveBeenCalled()
	})
})

describe("PreviewOverlay — a chat embed's linked file", () => {
	function renderOverlay(downloadable: boolean): void {
		render(
			createElement(PreviewOverlay, {
				variant: "links" as const,
				items: [{ type: "drive" as const, item: linkedFileIntoDriveItem(linkedFile(downloadable)) }],
				index: 0,
				onStep: vi.fn(),
				onClose: vi.fn(),
				onItemRemoved: vi.fn(),
				downloadable
			}),
			{ wrapper }
		)
	}

	it("offers Download when the link allows it", () => {
		renderOverlay(true)

		expect(screen.getByRole("button", { name: "Download" })).toBeDefined()
	})

	it("offers none when it doesn't", () => {
		renderOverlay(false)

		expect(screen.getByText("archive.bin")).toBeDefined()
		expect(screen.queryByRole("button", { name: "Download" })).toBeNull()
	})
})

describe("media controls", () => {
	it("drop the native download entry only for a file that may not be saved", () => {
		expect(mediaControlsList(true)).toBeUndefined()
		expect(mediaControlsList(false)).toBe("nodownload")
	})

	it("carry it through the preview's downloadable context", () => {
		const { container, rerender } = render(
			createElement(PreviewDownloadableProvider, {
				downloadable: false,
				children: createElement(MediaElement, { category: "audio", url: "blob:audio", alt: "a" })
			})
		)

		expect(container.querySelector("audio")?.getAttribute("controlslist")).toBe("nodownload")

		rerender(createElement(MediaElement, { category: "video", url: "blob:video", alt: "v" }))

		expect(container.querySelector("video")?.hasAttribute("controlslist")).toBe(false)
	})
})
