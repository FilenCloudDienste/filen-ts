import { describe, expect, it } from "vitest"
import {
	bytesOrigin,
	originAnonSafe,
	originKey,
	originRanged,
	originSize,
	originWhole,
	type ByteOrigin,
	type EntryAccessKind
} from "@/lib/sdk/byteOrigin"
import { mockLinkedFile } from "@/tests/fixtures/sdk"

const file = mockLinkedFile({ uuid: "a0000000-0000-0000-0000-000000000000", size: 42n })
const ACCESS: readonly EntryAccessKind[] = ["mapped", "seekable", "whole", "sequential"]

function entry(access: EntryAccessKind, anon = false): ByteOrigin {
	return {
		kind: "entry",
		reader: "reader-1",
		entry: { archive: file.uuid, index: 3 },
		size: 7,
		access,
		anon,
		cacheKey: `${file.uuid}#3`
	}
}

const ORIGINS: readonly ByteOrigin[] = [
	{ kind: "file", file },
	{ kind: "linkedFile", file },
	...ACCESS.map(access => entry(access)),
	...ACCESS.map(access => entry(access, true)),
	bytesOrigin(new Blob([new Uint8Array(5)]), `${file.uuid}/att0`)
]

describe("byteOrigin", () => {
	it("holds exactly one of ranged and whole for every origin", () => {
		for (const origin of ORIGINS) {
			expect(originRanged(origin) !== originWhole(origin)).toBe(true)
		}
	})

	it("reads files and mapped or seekable entries by range, the rest whole", () => {
		expect(originRanged({ kind: "file", file })).toBe(true)
		expect(originRanged({ kind: "linkedFile", file })).toBe(true)
		expect(ACCESS.map(access => originRanged(entry(access)))).toEqual([true, true, false, false])
		expect(originWhole(bytesOrigin(new Blob([]), "k"))).toBe(true)
	})

	it("sizes and keys every kind", () => {
		expect(originSize({ kind: "file", file })).toBe(42)
		expect(originSize(entry("whole"))).toBe(7)
		expect(originSize(bytesOrigin(new Blob([new Uint8Array(5)]), "k"))).toBe(5)
		expect(originKey({ kind: "file", file })).toBe(file.uuid)
		expect(originKey({ kind: "linkedFile", file })).toBe(file.uuid)
		expect(originKey(entry("mapped"))).toBe(`${file.uuid}#3`)
		expect(originKey(bytesOrigin(new Blob([]), "parent/att1"))).toBe("parent/att1")
	})

	it("is anon-safe only for what needs no session", () => {
		expect(originAnonSafe({ kind: "file", file })).toBe(false)
		expect(originAnonSafe({ kind: "linkedFile", file })).toBe(true)
		expect(originAnonSafe(bytesOrigin(new Blob([]), "k"))).toBe(true)
		expect(originAnonSafe(entry("mapped"))).toBe(false)
		expect(originAnonSafe(entry("mapped", true))).toBe(true)
	})
})
