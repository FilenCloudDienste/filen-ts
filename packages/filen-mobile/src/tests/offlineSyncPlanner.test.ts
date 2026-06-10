import { describe, it, expect } from "vitest"
import { planTreeReconcile, tmpPathForUuid, type RemoteTreeEntry, type LocalTreeEntry } from "@/features/offline/offlineSyncPlanner"

function remote(entries: [string, string, boolean?][]): Map<string, RemoteTreeEntry> {
	return new Map(entries.map(([uuid, path, isDirectory]) => [uuid, { uuid, path, isDirectory: isDirectory ?? false }]))
}

function local(entries: [string, string, boolean?, boolean?][]): LocalTreeEntry[] {
	return entries.map(([uuid, path, isDirectory, existsOnDisk]) => ({
		uuid,
		path,
		isDirectory: isDirectory ?? false,
		existsOnDisk: existsOnDisk ?? true
	}))
}

describe("planTreeReconcile", () => {
	it("no-op when remote and local match", () => {
		const plan = planTreeReconcile({
			remote: remote([["d1", "/sub", true], ["f1", "/sub/a.txt"]]),
			local: local([["d1", "/sub", true], ["f1", "/sub/a.txt"]]),
			allowDeletes: true
		})

		expect(plan.ops).toEqual([])
		expect(plan.missingUuids).toEqual([])
	})

	it("classifies only-remote as missing", () => {
		const plan = planTreeReconcile({
			remote: remote([["f1", "/a.txt"]]),
			local: local([]),
			allowDeletes: true
		})

		expect(plan.missingUuids).toEqual(["f1"])
		expect(plan.ops).toEqual([])
	})

	it("treats meta entries missing on disk as missing (self-heal)", () => {
		const plan = planTreeReconcile({
			remote: remote([["f1", "/a.txt"]]),
			local: local([["f1", "/a.txt", false, false]]),
			allowDeletes: true
		})

		expect(plan.missingUuids).toEqual(["f1"])
		expect(plan.ops).toEqual([])
	})

	it("deletes only-local entries deepest first", () => {
		const plan = planTreeReconcile({
			remote: remote([]),
			local: local([["d1", "/sub", true], ["f1", "/sub/a.txt"]]),
			allowDeletes: true
		})

		expect(plan.ops).toEqual([
			{ type: "delete", uuid: "f1", path: "/sub/a.txt", isDirectory: false },
			{ type: "delete", uuid: "d1", path: "/sub", isDirectory: true }
		])
	})

	it("skips deletes when allowDeletes is false (degraded listing)", () => {
		const plan = planTreeReconcile({
			remote: remote([]),
			local: local([["f1", "/a.txt"]]),
			allowDeletes: false
		})

		expect(plan.ops).toEqual([])
	})

	it("renames a file via two-phase temp", () => {
		const plan = planTreeReconcile({
			remote: remote([["f1", "/b.txt"]]),
			local: local([["f1", "/a.txt"]]),
			allowDeletes: true
		})

		expect(plan.ops).toEqual([
			{ type: "move", uuid: "f1", from: "/a.txt", to: tmpPathForUuid("f1"), isDirectory: false },
			{ type: "move", uuid: "f1", from: tmpPathForUuid("f1"), to: "/b.txt", isDirectory: false }
		])
	})

	it("renames a directory with one op pair — children ride along", () => {
		const plan = planTreeReconcile({
			remote: remote([["d1", "/new", true], ["f1", "/new/a.txt"], ["f2", "/new/deep/b.txt"], ["d2", "/new/deep", true]]),
			local: local([["d1", "/old", true], ["f1", "/old/a.txt"], ["f2", "/old/deep/b.txt"], ["d2", "/old/deep", true]]),
			allowDeletes: true
		})

		expect(plan.ops).toEqual([
			{ type: "move", uuid: "d1", from: "/old", to: tmpPathForUuid("d1"), isDirectory: true },
			{ type: "move", uuid: "d1", from: tmpPathForUuid("d1"), to: "/new", isDirectory: true }
		])
		expect(plan.missingUuids).toEqual([])
	})

	it("handles an independent child move out of a moving directory", () => {
		const plan = planTreeReconcile({
			remote: remote([["d1", "/new", true], ["f1", "/elsewhere.txt"]]),
			local: local([["d1", "/old", true], ["f1", "/old/a.txt"]]),
			allowDeletes: true
		})

		// d1 is the shallow explicit mover; f1's move is NOT explained by d1's rename
		// (it leaves the tree subdir), so it is extracted first (deeper local path).
		expect(plan.ops).toEqual([
			{ type: "move", uuid: "f1", from: "/old/a.txt", to: tmpPathForUuid("f1"), isDirectory: false },
			{ type: "move", uuid: "d1", from: "/old", to: tmpPathForUuid("d1"), isDirectory: true },
			{ type: "move", uuid: "d1", from: tmpPathForUuid("d1"), to: "/new", isDirectory: true },
			{ type: "move", uuid: "f1", from: tmpPathForUuid("f1"), to: "/elsewhere.txt", isDirectory: false }
		])
	})

	it("handles swap collisions via temps", () => {
		const plan = planTreeReconcile({
			remote: remote([["f1", "/b.txt"], ["f2", "/a.txt"]]),
			local: local([["f1", "/a.txt"], ["f2", "/b.txt"]]),
			allowDeletes: true
		})

		const moves = plan.ops.filter(op => op.type === "move")

		expect(moves).toHaveLength(4)
		// both extracted before either is placed
		expect(moves[0]?.to.startsWith("/.sync-tmp-")).toBe(true)
		expect(moves[1]?.to.startsWith("/.sync-tmp-")).toBe(true)
	})

	it("handles case-only renames (two-phase makes them safe on case-insensitive fs)", () => {
		const plan = planTreeReconcile({
			remote: remote([["f1", "/Foto.jpg"]]),
			local: local([["f1", "/foto.jpg"]]),
			allowDeletes: true
		})

		expect(plan.ops).toEqual([
			{ type: "move", uuid: "f1", from: "/foto.jpg", to: tmpPathForUuid("f1"), isDirectory: false },
			{ type: "move", uuid: "f1", from: tmpPathForUuid("f1"), to: "/Foto.jpg", isDirectory: false }
		])
	})

	it("preserves raw percent-escape names verbatim", () => {
		const name = "/10000   %20 00037.jpg"
		const plan = planTreeReconcile({
			remote: remote([["f1", name]]),
			local: local([["f1", name]]),
			allowDeletes: true
		})

		expect(plan.ops).toEqual([])
		expect(plan.missingUuids).toEqual([])
	})

	it("deletes only-local children inside a moving directory at their post-move temp path", () => {
		const plan = planTreeReconcile({
			remote: remote([["d1", "/new", true]]),
			local: local([["d1", "/old", true], ["f1", "/old/gone.txt"]]),
			allowDeletes: true
		})

		expect(plan.ops).toEqual([
			{ type: "move", uuid: "d1", from: "/old", to: tmpPathForUuid("d1"), isDirectory: true },
			{ type: "delete", uuid: "f1", path: `${tmpPathForUuid("d1")}/gone.txt`, isDirectory: false },
			{ type: "move", uuid: "d1", from: tmpPathForUuid("d1"), to: "/new", isDirectory: true }
		])
	})
})
