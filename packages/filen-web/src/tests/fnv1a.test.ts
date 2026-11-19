import { describe, expect, it } from "vitest"
import { FNV1A_OFFSET_BASIS, fnv1a } from "@/lib/fnv1a"

describe("fnv1a", () => {
	it("matches the reference 32-bit FNV-1a values, unsigned", () => {
		expect(fnv1a("")).toBe(FNV1A_OFFSET_BASIS)
		expect(fnv1a("a")).toBe(0xe40c292c)
		expect(fnv1a("foobar")).toBe(0xbf9cf968)
	})

	it("continues a running hash from a seed", () => {
		expect(fnv1a("bar", fnv1a("foo"))).toBe(fnv1a("foobar"))
		expect(fnv1a("foobar", FNV1A_OFFSET_BASIS)).toBe(fnv1a("foobar"))
	})
})
