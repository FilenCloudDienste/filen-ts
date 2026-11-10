// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DriveItem } from "@/features/drive/lib/item"
import type { Transfer } from "@/features/transfers/store/useTransfersStore"
import { TRANSFERS_ACTIONS } from "@/features/transfers/lib/keymap"
import { focusedTransferId, landedRevealItem, transferRowCommands } from "@/features/transfers/lib/rowKeys.logic"

// The registry's only storage boundary, as every other keymap test stubs it.
const { kvStore } = vi.hoisted(() => ({ kvStore: new Map<string, unknown>() }))

vi.mock("@/lib/storage/adapter", () => ({
	kvGetJson: (key: string) => Promise.resolve(kvStore.get(key) ?? null),
	kvSetJson: (key: string, value: unknown) => {
		kvStore.set(key, value)

		return Promise.resolve()
	},
	kvDelete: (key: string) => {
		kvStore.delete(key)

		return Promise.resolve()
	}
}))

async function freshRegistry() {
	vi.resetModules()

	return import("@/lib/keymap/registry")
}

function transfer(overrides: Partial<Transfer>): Transfer {
	return {
		id: "t",
		direction: "upload",
		name: "a.txt",
		size: 1,
		bytesTransferred: 0,
		status: "uploading",
		paused: false,
		parentUuid: null,
		startedAt: 0,
		...overrides
	}
}

// Only its identity is read here.
const ITEM = { type: "file", data: { uuid: "f" } } as unknown as DriveItem

beforeEach(() => {
	kvStore.clear()
})

afterEach(() => {
	document.body.replaceChildren()
})

describe("TRANSFERS_ACTIONS", () => {
	it("live in the transfers scope under the transfers namespace", () => {
		for (const def of TRANSFERS_ACTIONS) {
			expect(def.scope, def.id).toBe("transfers")
			expect(def.id.startsWith("transfers."), def.id).toBe(true)
		}
	})

	it("keep pause all off Firefox's private window and leave clear finished unset", () => {
		expect(TRANSFERS_ACTIONS.find(def => def.id === "transfers.togglePauseAll")?.defaultCombo).toBe("alt+shift+p")
		expect(TRANSFERS_ACTIONS.find(def => def.id === "transfers.clearFinished")?.defaultCombo).toBe("")
	})

	it("resolve to their defaults, and to a user's override", async () => {
		const { registerAction, comboFor, setUserCombo } = await freshRegistry()

		for (const def of TRANSFERS_ACTIONS) {
			registerAction(def)
		}

		expect(comboFor("transfers.cancelAll")).toBe("mod+shift+backspace")
		expect(comboFor("transfers.rowPause")).toBe("space")

		await setUserCombo("transfers.rowDetails", "shift+i")

		expect(comboFor("transfers.rowDetails")).toBe("shift+i")
	})
})

describe("focusedTransferId", () => {
	it("names the row only while the row itself has focus, never one of its buttons", () => {
		const row = document.createElement("li")
		const button = document.createElement("button")

		row.setAttribute("data-transfer-id", "t1")
		row.append(button)
		document.body.append(row)

		expect(focusedTransferId(row)).toBe("t1")
		expect(focusedTransferId(button)).toBeNull()
		expect(focusedTransferId(document.body)).toBeNull()
		expect(focusedTransferId(null)).toBeNull()
	})
})

describe("transferRowCommands", () => {
	it("pauses and cancels an active transfer", () => {
		expect([...transferRowCommands(transfer({}), undefined)].sort()).toEqual(["cancel", "pause"])
	})

	it("never pauses a download the browser manages", () => {
		expect([
			...transferRowCommands(transfer({ direction: "download", status: "downloading", browserManaged: true }), undefined)
		]).toEqual(["cancel"])
	})

	it("removes a finished transfer, and opens where it landed when that is known", () => {
		expect([...transferRowCommands(transfer({ status: "done", item: ITEM }), undefined)].sort()).toEqual(["remove", "reveal"])
		expect([...transferRowCommands(transfer({ status: "error" }), undefined)]).toEqual(["remove"])
	})

	it("reveals only a landed transfer's item", () => {
		expect(landedRevealItem(transfer({ status: "done", item: ITEM }), undefined)).toBe(ITEM)
		expect(landedRevealItem(transfer({ status: "error", item: ITEM }), undefined)).toBeNull()
		expect(landedRevealItem(transfer({ item: ITEM }), undefined)).toBeNull()
	})
})
