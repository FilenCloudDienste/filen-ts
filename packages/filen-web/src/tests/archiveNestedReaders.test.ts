import { describe, expect, it, vi } from "vitest"
import type { AnyFile } from "@filen/sdk-rs"
import {
	acquireArchiveReader,
	fileTarget,
	nestedTarget,
	nestedUuid,
	type ArchiveReaderPageDeps,
	type ReaderTarget
} from "@/features/archive/lib/archiveReaders"

// The page's nested readers (W6 §6.1 A): one inside another's entry opens through its parent's reader, holds the
// parent open while it is, and nests three deep at most.

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))

const FILE = { uuid: "f0000000-0000-0000-0000-000000000000" } as unknown as AnyFile

function deps() {
	let ids = 0
	const calls: string[] = []
	const page: ArchiveReaderPageDeps = {
		open: id => calls.push(`open ${id}`),
		openNested: (id, parentId, entry, password) =>
			calls.push(`nested ${id} in ${parentId} at ${entry.archive}#${String(entry.index)} pw=${password ?? ""}`),
		close: id => calls.push(`close ${id}`),
		heldBytes: () => Promise.resolve(10 * 1024 * 1024),
		newId: () => `r${String(++ids)}`,
		linger: close => {
			close()

			return () => undefined
		}
	}

	return { page, calls }
}

function nested(parent: ReaderTarget, index: number): ReaderTarget {
	const step = nestedTarget(parent, "outer-pw", index)

	if (step === null) {
		throw new Error("too deep")
	}

	return { file: parent.file, uuid: nestedUuid(parent, index), anon: parent.anon, nested: step }
}

describe("nested archive readers", () => {
	it("opens an inner archive through its parent's reader, and lets the parent go once it closes", async () => {
		const { page, calls } = deps()
		const outer = fileTarget(FILE, false)
		const inner = nested(outer, 4)
		const ref = acquireArchiveReader(inner, "inner-pw", page)

		expect(calls).toEqual(["open r2", `nested r1 in r2 at ${FILE.uuid}#4 pw=inner-pw`])
		ref.release()
		await vi.waitFor(() => {
			expect(calls).toContain("close r1")
		})
		await vi.waitFor(() => {
			expect(calls.at(-1)).toBe("close r2")
		})
	})

	it("nests three deep at most, chaining cache keys from the outermost file", () => {
		const outer = fileTarget(FILE, false)
		const second = nested(outer, 1)
		const third = nested(second, 2)

		expect(third.uuid).toBe(`${FILE.uuid}/1/2`)
		expect(third.nested?.depth).toBe(3)
		expect(nestedTarget(third, undefined, 3)).toBeNull()
	})
})
