import { describe, expect, it, vi } from "vitest"
import { emitBranchChange, reroutedPath, reroutedRoute, subscribeBranchChanges } from "@/features/drive/lib/branchChanges"
import { type ParentLookup } from "@/features/drive/components/moveTargetDialog.logic"

// root > a > b > c is the route; x sits at the root, y inside x.
const PARENTS = new Map<string, string | null>([
	["a", null],
	["b", "a"],
	["c", "b"],
	["x", null],
	["y", "x"]
])

function parents(): ParentLookup {
	return uuid => PARENTS.get(uuid)
}

const ROUTE = ["a", "b", "c"]

describe("reroutedPath", () => {
	it("leaves a route the change doesn't touch alone, without reading any parent", () => {
		const readParents = vi.fn(parents)

		expect(reroutedPath(ROUTE, { type: "moved", uuid: "x", parentUuid: null }, readParents)).toBeNull()
		expect(reroutedPath(ROUTE, { type: "trashed", uuid: "x" }, readParents)).toBeNull()
		expect(readParents).not.toHaveBeenCalled()
	})

	it("sends a route through a trashed directory to that directory's parent", () => {
		expect(reroutedPath(ROUTE, { type: "trashed", uuid: "b" }, parents)).toEqual(["a"])
		expect(reroutedPath(ROUTE, { type: "trashed", uuid: "a" }, parents)).toEqual([])
		expect(reroutedPath(ROUTE, { type: "trashed", uuid: "c" }, parents)).toEqual(["a", "b"])
	})

	it("keeps a moved directory's tail under its new parent's cached chain", () => {
		expect(reroutedPath(ROUTE, { type: "moved", uuid: "b", parentUuid: "y" }, parents)).toEqual(["x", "y", "b", "c"])
		expect(reroutedPath(ROUTE, { type: "moved", uuid: "b", parentUuid: null }, parents)).toEqual(["b", "c"])
	})

	it("starts a fresh chain at the moved directory when its new parent's chain isn't cached", () => {
		expect(reroutedPath(ROUTE, { type: "moved", uuid: "b", parentUuid: "unknown" }, parents)).toEqual(["b", "c"])
	})

	// The socket echoes a move this client made: by then the route already follows it.
	it("is a no-op for a move the route already reflects", () => {
		expect(reroutedPath(["x", "y", "b", "c"], { type: "moved", uuid: "b", parentUuid: "y" }, parents)).toBeNull()
		expect(reroutedPath(["b", "c"], { type: "moved", uuid: "b", parentUuid: "unknown" }, parents)).toBeNull()
	})
})

// Shared by me: s is shared, a and b below it; x and y are elsewhere in My Drive.
describe("reroutedRoute", () => {
	const SHARED = ["s", "a", "b"]

	it("routes My Drive through reroutedPath, and leaves listings with no own chain alone", () => {
		expect(reroutedRoute("drive", ROUTE, { type: "trashed", uuid: "b" }, parents)).toEqual({ to: "/drive/$", path: ["a"] })

		for (const variant of ["recents", "favorites", "trash", "links", "sharedIn"] as const) {
			expect(reroutedRoute(variant, ROUTE, { type: "trashed", uuid: "b" }, parents)).toBeNull()
		}
	})

	it("leaves a Shared by me route through a trashed directory for that directory's parent", () => {
		expect(reroutedRoute("sharedOut", SHARED, { type: "trashed", uuid: "a" }, parents)).toEqual({ to: "/shared-out/$", path: ["s"] })
		expect(reroutedRoute("sharedOut", SHARED, { type: "trashed", uuid: "s" }, parents)).toEqual({ to: "/shared-out/$", path: [] })
	})

	it("keeps the shared directory's route wherever it moves, and a move under the same parent", () => {
		expect(reroutedRoute("sharedOut", SHARED, { type: "moved", uuid: "s", parentUuid: "x" }, parents)).toBeNull()
		expect(reroutedRoute("sharedOut", SHARED, { type: "moved", uuid: "b", parentUuid: "a" }, parents)).toBeNull()
	})

	it("stays in the share for a move under a directory the route holds, and follows one out of it into My Drive", () => {
		expect(reroutedRoute("sharedOut", SHARED, { type: "moved", uuid: "b", parentUuid: "s" }, parents)).toEqual({
			to: "/shared-out/$",
			path: ["s", "b"]
		})
		expect(reroutedRoute("sharedOut", SHARED, { type: "moved", uuid: "a", parentUuid: "y" }, parents)).toEqual({
			to: "/drive/$",
			path: ["x", "y", "a", "b"]
		})
	})
})

describe("branch change subscription", () => {
	it("delivers each change to every subscriber until it unsubscribes", () => {
		const listener = vi.fn()
		const unsubscribe = subscribeBranchChanges(listener)

		emitBranchChange({ type: "trashed", uuid: "b" })
		unsubscribe()
		emitBranchChange({ type: "trashed", uuid: "c" })

		expect(listener).toHaveBeenCalledExactlyOnceWith({ type: "trashed", uuid: "b" })
	})
})
