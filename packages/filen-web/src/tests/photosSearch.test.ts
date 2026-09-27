import { describe, expect, it } from "vitest"
import type { File, UuidStr } from "@filen/sdk-rs"
import { narrowItem } from "@/features/drive/lib/item"
import { type PhotoItem } from "@/features/photos/lib/captureSort"
import {
	EMPTY_PHOTOS_FILTER,
	filterPhotos,
	isPhotosFilterActive,
	monthNameTable,
	normalizeSearchText,
	parsePhotosQuery,
	photoKindsPresent,
	type PhotosFilter
} from "@/features/photos/lib/search"

const MONTHS = monthNameTable("en")
const ROME = "rome-0000-0000-0000-000000000000"

function photo(label: string, name: string, captured: Date, overrides: Partial<File> = {}): PhotoItem {
	const mime = name.endsWith(".mp4") ? "video/mp4" : "image/jpeg"
	const item = narrowItem({
		uuid: `${label}-0000-0000-0000-000000000000` as UuidStr,
		stableUUID: undefined,
		parent: "root-0000-0000-0000-000000000000" as UuidStr,
		size: 1n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: BigInt(captured.getTime()),
		chunks: 1n,
		canMakeThumbnail: true,
		meta: {
			type: "decoded",
			data: { name, mime, created: BigInt(captured.getTime()), modified: BigInt(captured.getTime()), size: 1n, key: "k", version: 2 }
		},
		...overrides
	} satisfies File)

	if (item.type !== "file") {
		throw new Error("a photo narrowed to a non-file arm")
	}

	return item
}

const BEACH = photo("beach", "IMG_4021.jpg", new Date(2023, 6, 15, 12), { parent: ROME as UuidStr })
const CLIP = photo("clip", "holiday.mp4", new Date(2023, 6, 2, 12), { favorited: true })
const RAW = photo("raw", "DSC_0001.nef", new Date(2022, 11, 24, 12))
const CAFE = photo("cafe", "Café.jpg", new Date(2021, 2, 1, 12))
const PHOTOS = [BEACH, CLIP, RAW, CAFE]
const FOLDERS = { [ROME]: "Italy 2023/Rome" }

function uuidsFor(filter: Partial<PhotosFilter>): string[] {
	return filterPhotos(PHOTOS, FOLDERS, { ...EMPTY_PHOTOS_FILTER, ...filter }, MONTHS).items.map(
		item => item.data.uuid.split("-")[0] ?? ""
	)
}

describe("parsePhotosQuery", () => {
	it("reads years, month names, days and ISO dates, keeping each word's text too", () => {
		expect(parsePhotosQuery("July 15, 2024", MONTHS)).toEqual([
			{ text: "july", month: 6 },
			{ text: "15", day: 15 },
			{ text: "2024", year: 2024 }
		])
		expect(parsePhotosQuery("2023-07", MONTHS)).toEqual([{ text: "2023-07", year: 2023, month: 6 }])
		expect(parsePhotosQuery("2023-07-15", MONTHS)).toEqual([{ text: "2023-07-15", year: 2023, month: 6, day: 15 }])
	})

	it("accepts short month names and unambiguous prefixes, not ambiguous ones", () => {
		expect(parsePhotosQuery("sep sept septem", MONTHS).map(token => token.month)).toEqual([8, 8, 8])
		expect(parsePhotosQuery("ju", MONTHS)).toEqual([{ text: "ju" }])
	})

	it("treats out-of-range numbers as plain text", () => {
		expect(parsePhotosQuery("0001 99", MONTHS)).toEqual([{ text: "0001" }, { text: "99" }])
	})
})

describe("filterPhotos", () => {
	it("returns the listing itself when nothing narrows it", () => {
		expect(filterPhotos(PHOTOS, FOLDERS, EMPTY_PHOTOS_FILTER, MONTHS).items).toBe(PHOTOS)
	})

	it("matches file names case- and accent-insensitively", () => {
		expect(uuidsFor({ query: "img_40" })).toEqual(["beach"])
		expect(uuidsFor({ query: "cafe" })).toEqual(["cafe"])
	})

	it("matches the folder path below the root", () => {
		expect(uuidsFor({ query: "rome" })).toEqual(["beach"])
		expect(uuidsFor({ query: "italy" })).toEqual(["beach"])
	})

	it("matches capture dates by year, month and day", () => {
		expect(uuidsFor({ query: "2023" })).toEqual(["beach", "clip"])
		expect(uuidsFor({ query: "july 2023" })).toEqual(["beach", "clip"])
		expect(uuidsFor({ query: "July 15, 2023" })).toEqual(["beach"])
		expect(uuidsFor({ query: "2022-12-24" })).toEqual(["raw"])
	})

	it("requires every word to match", () => {
		expect(uuidsFor({ query: "rome 2022" })).toEqual([])
		expect(uuidsFor({ query: "holiday july" })).toEqual(["clip"])
	})

	it("combines the kind and favorites filters with the query", () => {
		expect(uuidsFor({ kind: "video" })).toEqual(["clip"])
		expect(uuidsFor({ kind: "rawImage" })).toEqual(["raw"])
		expect(uuidsFor({ kind: "image" })).toEqual(["beach", "cafe"])
		expect(uuidsFor({ favoritesOnly: true })).toEqual(["clip"])
		expect(uuidsFor({ query: "2023", kind: "image" })).toEqual(["beach"])
	})

	it("returns each match's date alongside it, for the month headers", () => {
		expect(
			filterPhotos(PHOTOS, FOLDERS, { ...EMPTY_PHOTOS_FILTER, query: "2023" }, MONTHS).entries.map(entry => [entry.year, entry.month])
		).toEqual([
			[2023, 6],
			[2023, 6]
		])
	})
})

describe("photoKindsPresent", () => {
	it("reports which kinds the listing holds", () => {
		expect([...photoKindsPresent(PHOTOS, FOLDERS)].sort()).toEqual(["image", "rawImage", "video"])
		expect([...photoKindsPresent([BEACH], FOLDERS)]).toEqual(["image"])
	})
})

describe("isPhotosFilterActive", () => {
	it("ignores a whitespace-only query", () => {
		expect(isPhotosFilterActive({ ...EMPTY_PHOTOS_FILTER, query: "   " })).toBe(false)
		expect(isPhotosFilterActive({ ...EMPTY_PHOTOS_FILTER, favoritesOnly: true })).toBe(true)
	})
})

describe("normalizeSearchText", () => {
	it("folds case and accents", () => {
		expect(normalizeSearchText("CaFÉ Ñandú")).toBe("cafe nandu")
	})
})
