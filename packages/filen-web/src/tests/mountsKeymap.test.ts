import { describe, expect, it } from "vitest"
import { defaultComboOn } from "@/lib/keymap/registry"
import { MOUNTS_ACTIONS } from "@/features/mounts/lib/keymap"
import { mountsPageOf, mountsPages } from "@/features/mounts/lib/mountsPages.logic"

const PLATFORM = { mac: false, desktop: true }

describe("MOUNTS_ACTIONS", () => {
	it("step with Alt+↑/↓ and leave the switch unset", () => {
		const combos = Object.fromEntries(MOUNTS_ACTIONS.map(action => [action.id, defaultComboOn(action, PLATFORM)]))

		expect(combos).toEqual({ "mounts.previousRole": "alt+arrowup", "mounts.nextRole": "alt+arrowdown", "mounts.toggleRole": "" })

		for (const action of MOUNTS_ACTIONS) expect(action.scope, action.id).toBe("mounts")
	})
})

describe("mountsPages", () => {
	it("lists the overview, Filen in Finder where offered, the drive, then the platform's servers", () => {
		expect(mountsPages({ platform: "darwin", finder: true }).slice(0, 4)).toEqual(["overview", "finder", "drive", "webdav"])
		expect(mountsPages({ platform: "win32", finder: false })).not.toContain("nfs")
	})
})

describe("mountsPageOf", () => {
	const pages = mountsPages({ platform: "linux", finder: false })

	it("reads the overview and the offered roles off the path", () => {
		expect(mountsPageOf("/mounts", pages)).toBe("overview")
		expect(mountsPageOf("/mounts/drive", pages)).toBe("drive")
		expect(mountsPageOf("/mounts/webdav", pages)).toBe("webdav")
	})

	it("is no page for a path outside Mounts or a role not offered", () => {
		expect(mountsPageOf("/sync", pages)).toBeNull()
		expect(mountsPageOf("/mounts/finder", pages)).toBeNull()
		expect(mountsPageOf("/mounts/overview", pages)).toBeNull()
	})
})
