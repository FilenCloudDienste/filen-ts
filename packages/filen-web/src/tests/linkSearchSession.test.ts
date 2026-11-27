import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AnyLinkedDir, DirPublicLink } from "@filen/sdk-rs"

// The page's side of a directory link's search: which listing it trusts the worker to hold.

const sdk = vi.hoisted(() => ({
	searchLinkedOpen: vi.fn<(dir: unknown, link: unknown, onProgress: unknown) => Promise<void>>(),
	searchLinkedRange: vi.fn<() => Promise<{ total: number; hits: never[] }>>(),
	searchLinkedClose: vi.fn<() => Promise<void>>()
}))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: sdk }))
vi.mock("comlink", () => ({ proxy: (value: unknown) => value }))

import { createLinkSearchSession, type LinkSearchScope } from "@/features/publicLinks/lib/linkSearch"

const LINK = { linkUuid: "link" } as unknown as DirPublicLink
const SCOPE: LinkSearchScope = { uuid: "dir", dir: {} as AnyLinkedDir, ancestry: [] }

async function settle(): Promise<void> {
	await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
	vi.clearAllMocks()
	sdk.searchLinkedOpen.mockResolvedValue(undefined)
	sdk.searchLinkedRange.mockResolvedValue({ total: 0, hits: [] })
	sdk.searchLinkedClose.mockResolvedValue(undefined)
})

describe("link search session", () => {
	it("asks the worker to open once per directory while only it opens listings", async () => {
		const session = createLinkSearchSession(LINK, vi.fn())

		session.search(SCOPE, "a", "nameAsc")
		await settle()
		session.search(SCOPE, "ab", "nameAsc")
		await settle()

		expect(sdk.searchLinkedOpen).toHaveBeenCalledTimes(1)
		expect(sdk.searchLinkedRange).toHaveBeenCalledTimes(2)
	})

	it("after a slideshow listed through the worker (which may hold another listing now), the next query opens again", async () => {
		const session = createLinkSearchSession(LINK, vi.fn())

		session.search(SCOPE, "a", "nameAsc")
		await settle()
		session.engage()
		session.search(SCOPE, "ab", "nameAsc")
		await settle()
		session.search(SCOPE, "abc", "nameAsc")
		await settle()

		expect(sdk.searchLinkedOpen).toHaveBeenCalledTimes(2)
		expect(sdk.searchLinkedRange).toHaveBeenCalledTimes(3)
	})

	it("a listing of its own under way as a slideshow lists is not taken as held once it lands", async () => {
		let land: () => void = () => undefined

		sdk.searchLinkedOpen.mockImplementationOnce(
			() =>
				new Promise(resolve => {
					land = () => {
						resolve(undefined)
					}
				})
		)

		const session = createLinkSearchSession(LINK, vi.fn())

		session.search(SCOPE, "a", "nameAsc")
		session.engage()
		land()
		await settle()
		session.search(SCOPE, "ab", "nameAsc")
		await settle()

		expect(sdk.searchLinkedOpen).toHaveBeenCalledTimes(2)
	})

	it("frees the worker's listing as the page goes once a slideshow listed, though it never searched", () => {
		const session = createLinkSearchSession(LINK, vi.fn())

		session.engage()
		session.close()

		expect(sdk.searchLinkedClose).toHaveBeenCalledTimes(1)
	})
})
