import path from "node:path"
import { localCollisionKey } from "@filen/shared/localName"
import { describe, expect, it } from "vitest"
import { freeTarget } from "../main/transfers/paths.ts"

const DIR = path.resolve("downloads")
const at = (name: string) => path.join(DIR, name)

function takenBy(...paths: string[]) {
	const keys = new Set(paths.map(taken => localCollisionKey(taken)))

	return (candidate: string) => Promise.resolve(keys.has(localCollisionKey(candidate)))
}

describe("freeTarget", () => {
	it("returns name when free", async () => {
		await expect(freeTarget(DIR, "a.txt", "file", takenBy())).resolves.toBe(at("a.txt"))
	})

	it('returns "a (1).txt" when a.txt is taken', async () => {
		await expect(freeTarget(DIR, "a.txt", "file", takenBy(at("a.txt")))).resolves.toBe(at("a (1).txt"))
	})

	it('returns "dir (2)" when dir and dir (1) are taken', async () => {
		await expect(freeTarget(DIR, "dir.d", "directory", takenBy(at("dir.d"), at("dir.d (1)")))).resolves.toBe(at("dir.d (2)"))
	})

	it('treats "A.TXT" as taken by a reservation for "a.txt"', async () => {
		await expect(freeTarget(DIR, "A.TXT", "file", takenBy(at("a.txt")))).resolves.toBe(at("A (1).TXT"))
	})
})
