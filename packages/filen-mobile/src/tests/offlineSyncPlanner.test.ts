import { describe, it, expect } from "vitest"
import {
	planTreeReconcile,
	tmpPathForUuid,
	isSyncTmpName,
	uuidFromSyncTmpName,
	type RemoteTreeEntry,
	type LocalTreeEntry
} from "@/features/offline/offlineSyncPlanner"

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

	// A3 — dir D (d1) deleted remotely, same-name dir D' (d2) created, child f1 still exists
	// remotely at the same relative path. Without the rescue, the recursive delete of d1 destroys
	// f1's bytes and forces a full re-transfer.
	describe("rescues remote-kept entries riding inside a deleted directory", () => {
		it("extracts the kept child before the delete and places it at its remote path (D→D' recreate) — never in missingUuids", () => {
			const plan = planTreeReconcile({
				remote: remote([["d2", "/D", true], ["f1", "/D/f.txt"]]),
				local: local([["d1", "/D", true], ["f1", "/D/f.txt"]]),
				allowDeletes: true
			})

			expect(plan.ops).toEqual([
				{ type: "move", uuid: "f1", from: "/D/f.txt", to: tmpPathForUuid("f1"), isDirectory: false },
				{ type: "delete", uuid: "d1", path: "/D", isDirectory: true },
				{ type: "move", uuid: "f1", from: tmpPathForUuid("f1"), to: "/D/f.txt", isDirectory: false }
			])
			// f1 is physically present — it must be rescued, not re-downloaded.
			expect(plan.missingUuids).toEqual(["d2"])
			expect(plan.deferredMoves).toEqual([])
		})

		it("rescues a file two levels deep under nested deleted directories", () => {
			const plan = planTreeReconcile({
				remote: remote([["d2", "/D", true], ["s2", "/D/sub", true], ["f1", "/D/sub/f.txt"]]),
				local: local([["d1", "/D", true], ["s1", "/D/sub", true], ["f1", "/D/sub/f.txt"]]),
				allowDeletes: true
			})

			expect(plan.ops).toEqual([
				{ type: "move", uuid: "f1", from: "/D/sub/f.txt", to: tmpPathForUuid("f1"), isDirectory: false },
				{ type: "delete", uuid: "s1", path: "/D/sub", isDirectory: true },
				{ type: "delete", uuid: "d1", path: "/D", isDirectory: true },
				{ type: "move", uuid: "f1", from: tmpPathForUuid("f1"), to: "/D/sub/f.txt", isDirectory: false }
			])
			expect(plan.missingUuids.sort()).toEqual(["d2", "s2"])
		})

		it("does not rescue an entry that already escapes inside an explicit-mover ancestor", () => {
			// d1 is deleted; M (kept) moves out of it and carries f1 along — f1 needs no extra ops.
			const plan = planTreeReconcile({
				remote: remote([["m1", "/M", true], ["f1", "/M/f.txt"]]),
				local: local([["d1", "/D", true], ["m1", "/D/M", true], ["f1", "/D/M/f.txt"]]),
				allowDeletes: true
			})

			expect(plan.ops).toEqual([
				{ type: "move", uuid: "m1", from: "/D/M", to: tmpPathForUuid("m1"), isDirectory: true },
				{ type: "delete", uuid: "d1", path: "/D", isDirectory: true },
				{ type: "move", uuid: "m1", from: tmpPathForUuid("m1"), to: "/M", isDirectory: true }
			])
			expect(plan.missingUuids).toEqual([])
		})

		it("rescues a kept entry nested under an only-local directory that itself rides inside a rescued directory", () => {
			// D and x both recreated under new uuids (d2/x2); u and y keep their uuids and relative
			// paths. u (kept) rides out of doomed d1; x1 (only-local dir) rides inside u's temp and
			// is deleted there — y (kept) under x1 must be rescued out of it first.
			const plan = planTreeReconcile({
				remote: remote([["d2", "/D", true], ["u1", "/D/u", true], ["x2", "/D/u/x", true], ["y1", "/D/u/x/y.txt"]]),
				local: local([
					["d1", "/D", true],
					["u1", "/D/u", true],
					["x1", "/D/u/x", true],
					["y1", "/D/u/x/y.txt"]
				]),
				allowDeletes: true
			})

			expect(plan.ops).toEqual([
				// u1 (shallower) is rescued first; x1 and y1 ride into its temp.
				{ type: "move", uuid: "u1", from: "/D/u", to: tmpPathForUuid("u1"), isDirectory: true },
				// y1 is still doomed (under x1's temp-prefixed path) — rescued out of x1.
				{ type: "move", uuid: "y1", from: `${tmpPathForUuid("u1")}/x/y.txt`, to: tmpPathForUuid("y1"), isDirectory: false },
				{ type: "delete", uuid: "x1", path: `${tmpPathForUuid("u1")}/x`, isDirectory: true },
				{ type: "delete", uuid: "d1", path: "/D", isDirectory: true },
				{ type: "move", uuid: "u1", from: tmpPathForUuid("u1"), to: "/D/u", isDirectory: true },
				{ type: "move", uuid: "y1", from: tmpPathForUuid("y1"), to: "/D/u/x/y.txt", isDirectory: false }
			])
			expect(plan.missingUuids.sort()).toEqual(["d2", "x2"])
		})
	})

	// A4 — degraded passes (allowDeletes: false) must not livelock: a phase-2 destination occupied
	// by a kept only-local entry would make the executor's move throw every pass (the delete phase
	// that would clear the occupant is skipped while the listing is degraded).
	describe("defers moves onto kept occupants when deletes are skipped (degraded listing)", () => {
		it("returns the colliding mover in deferredMoves with NO ops for it — the entry stays at its current path", () => {
			const plan = planTreeReconcile({
				remote: remote([["f1", "/new.txt"]]),
				local: local([["f1", "/old.txt"], ["f2", "/new.txt"]]),
				allowDeletes: false
			})

			expect(plan.ops).toEqual([])
			expect(plan.deferredMoves).toEqual(["f1"])
			expect(plan.missingUuids).toEqual([])
		})

		it("still plans the move when deletes are allowed — the occupant is deleted before placement", () => {
			const plan = planTreeReconcile({
				remote: remote([["f1", "/new.txt"]]),
				local: local([["f1", "/old.txt"], ["f2", "/new.txt"]]),
				allowDeletes: true
			})

			expect(plan.ops).toEqual([
				{ type: "move", uuid: "f1", from: "/old.txt", to: tmpPathForUuid("f1"), isDirectory: false },
				{ type: "delete", uuid: "f2", path: "/new.txt", isDirectory: false },
				{ type: "move", uuid: "f1", from: tmpPathForUuid("f1"), to: "/new.txt", isDirectory: false }
			])
			expect(plan.deferredMoves).toEqual([])
		})

		it("cascades: a deferred mover is itself a stay that defers movers targeting ITS path", () => {
			// o (only-local) blocks m1's destination; deferred m1 stays at /a, blocking m2 → /a.
			const plan = planTreeReconcile({
				remote: remote([["m1", "/x.txt"], ["m2", "/a.txt"]]),
				local: local([["m1", "/a.txt"], ["m2", "/b.txt"], ["o1", "/x.txt"]]),
				allowDeletes: false
			})

			expect(plan.ops).toEqual([])
			expect(plan.deferredMoves.sort()).toEqual(["m1", "m2"])
		})

		it("keeps non-colliding movers planned while deferring only the colliding one", () => {
			const plan = planTreeReconcile({
				remote: remote([["f1", "/blocked.txt"], ["f3", "/free.txt"]]),
				local: local([["f1", "/a.txt"], ["f3", "/c.txt"], ["o1", "/blocked.txt"]]),
				allowDeletes: false
			})

			expect(plan.ops).toEqual([
				{ type: "move", uuid: "f3", from: "/c.txt", to: tmpPathForUuid("f3"), isDirectory: false },
				{ type: "move", uuid: "f3", from: tmpPathForUuid("f3"), to: "/free.txt", isDirectory: false }
			])
			expect(plan.deferredMoves).toEqual(["f1"])
		})
	})
})

describe("sync-tmp name helpers", () => {
	it("round-trips a uuid through tmpPathForUuid → name → uuidFromSyncTmpName (the crash-rescue contract)", () => {
		const uuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
		const tmpName = tmpPathForUuid(uuid).slice(1)

		expect(isSyncTmpName(tmpName)).toBe(true)
		expect(uuidFromSyncTmpName(tmpName)).toBe(uuid)
	})

	it("returns null for non-temp and malformed names", () => {
		expect(uuidFromSyncTmpName("a.txt")).toBeNull()
		expect(uuidFromSyncTmpName(".filenmeta")).toBeNull()
		// A bare prefix with no uuid suffix is malformed — never rescuable.
		expect(uuidFromSyncTmpName(".sync-tmp-")).toBeNull()
		expect(isSyncTmpName("a.txt")).toBe(false)
	})
})
