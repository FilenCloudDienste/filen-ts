import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Dir, File } from "@filen/sdk-rs"

vi.mock("@/queries/client", async () => {
	const { QueryClient } = await import("@tanstack/react-query")

	return { queryClient: new QueryClient() }
})

const sdkCalls = vi.hoisted(() => ({ count: 0 }))

// Any worker call is a request this feature must never make.
vi.mock("@/lib/sdk/client", () => ({
	sdkApi: new Proxy(
		{},
		{
			get: () => () => {
				sdkCalls.count++

				return Promise.reject(new Error("no requests"))
			}
		}
	)
}))

import { queryClient } from "@/queries/client"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { type DriveVariant } from "@/features/drive/lib/preferences"
import { cachedItemLocations, locationParentUuid, showsItemLocation } from "@/features/drive/lib/itemLocation"
import { testUuid } from "@/tests/support/uuid"

const ROOT = testUuid("root")
const ROOT_LABEL = "Cloud Drive"

function dir(label: string, parent: string, extra: Partial<Dir> = {}): DriveItem {
	return narrowItem({
		uuid: testUuid(label),
		parent: parent === "trash" ? "trash" : testUuid(parent),
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name: label } },
		...extra
	})
}

function file(label: string, parent: File["parent"], extra: Partial<File> = {}): DriveItem {
	return narrowItem({
		uuid: testUuid(label),
		stableUUID: undefined,
		parent,
		size: 1n,
		favorited: false,
		region: "",
		bucket: "",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name: label, mime: "text/plain", size: 1n, key: "", version: 2, created: 0n, modified: 0n } },
		...extra
	} as unknown as File)
}

function seed(variant: DriveVariant, uuid: string | null, items: DriveItem[]): void {
	queryClient.setQueryData(["drive", "listing", { variant, uuid }], items)
}

beforeEach(() => {
	queryClient.clear()
	sdkCalls.count = 0
})

describe("showsItemLocation", () => {
	it("is on for the flat listings whose rows come from anywhere", () => {
		expect(showsItemLocation("recents")).toBe(true)
		expect(showsItemLocation("favorites")).toBe(true)
		expect(showsItemLocation("trash")).toBe(true)
		expect(showsItemLocation("drive")).toBe(false)
		expect(showsItemLocation("links")).toBe(false)
		expect(showsItemLocation("sharedIn")).toBe(false)
	})
})

describe("locationParentUuid", () => {
	it("is the parent, or for a trashed item where Restore puts it", () => {
		expect(locationParentUuid(file("a", testUuid("docs")))).toBe(testUuid("docs"))
		expect(locationParentUuid(file("b", "trash", { trashedFrom: testUuid("docs") }))).toBe(testUuid("docs"))
		expect(locationParentUuid(file("c", "trash"))).toBeUndefined()
		expect(locationParentUuid(file("d", "recents"))).toBeUndefined()
	})
})

describe("cachedItemLocations", () => {
	it("names the parent and builds the full path from cached listings, with no request", () => {
		seed("drive", null, [dir("docs", "root")])
		seed("drive", testUuid("docs"), [dir("work", "docs")])

		const recent = file("report", testUuid("work"))
		const atRoot = file("top", ROOT)
		const locations = cachedItemLocations({ items: [recent, atRoot], rootUuid: ROOT, rootLabel: ROOT_LABEL })

		expect(locations.name(recent)).toBe("work")
		expect(locations.path(recent)).toBe("Cloud Drive / docs / work")
		expect(locations.name(atRoot)).toBe(ROOT_LABEL)
		expect(locations.path(atRoot)).toBe(ROOT_LABEL)
		expect(sdkCalls.count).toBe(0)
	})

	it("shows where a trashed item is restored to", () => {
		seed("drive", null, [dir("docs", "root")])

		const trashed = file("old", "trash", { trashedFrom: testUuid("docs") })
		const locations = cachedItemLocations({ items: [trashed], rootUuid: ROOT, rootLabel: ROOT_LABEL })

		expect(locations.name(trashed)).toBe("docs")
		expect(locations.path(trashed)).toBe("Cloud Drive / docs")
	})

	it("keeps the parent's name when the chain above it is not cached, and shows nothing for an unknown parent", () => {
		// Only the breadcrumb's name entry knows "deep"; no listing places it.
		queryClient.setQueryData(["drive", "names", "drive", testUuid("deep")], "deep")

		const known = file("a", testUuid("deep"))
		const unknown = file("b", testUuid("elsewhere"))
		const locations = cachedItemLocations({ items: [known, unknown], rootUuid: ROOT, rootLabel: ROOT_LABEL })

		expect(locations.name(known)).toBe("deep")
		expect(locations.path(known)).toBeUndefined()
		expect(locations.name(unknown)).toBeUndefined()
		expect(locations.path(unknown)).toBeUndefined()
		expect(sdkCalls.count).toBe(0)
	})
})
