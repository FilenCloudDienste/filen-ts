import { describe, expect, it, vi } from "vitest"
import { bytesSource } from "../core/opc/index"
import { openXlsxSession } from "../core/sheet/commands"
import type { SheetEvent, SheetOpenResult } from "../core/sheet/protocol"
import { inThreadSheetHost } from "../dom/sheet/host"
import { openProtectedWorkbook, sheetUnlockedPackage, takenSheetEncryption } from "../dom/sheet/protection"
import { agileStreams, encryptedOfficeFile } from "./encryption/testing"
import { BASIC, IMMEDIATE, buildFixture, cells, firstTile, tileTexts, workerPair } from "./sheetSessionFixtures"

// The hosts sessions run in: on the calling thread (no Worker, MessageChannel or OffscreenCanvas), in a worker
// over messages, and for password-protected workbooks (unlocked where the session runs, every save sealed).

const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

function sealed(bytes: Uint8Array): boolean {
	return CFB.every((byte, k) => bytes[k] === byte)
}

function opened(result: SheetOpenResult): Extract<SheetOpenResult, { kind: "opened" }> {
	if (result.kind !== "opened") throw new Error(`expected an open, got ${result.kind}`)

	return result
}

describe("in-thread sheet host", () => {
	it("opens, edits and saves without Worker, MessageChannel or OffscreenCanvas", async () => {
		vi.stubGlobal("Worker", undefined)
		vi.stubGlobal("MessageChannel", undefined)
		vi.stubGlobal("OffscreenCanvas", undefined)

		const host = inThreadSheetHost()
		const { session, info } = opened(await host.open(buildFixture(BASIC), { kind: "xlsx" }, () => undefined))
		const one = info.sheets[0]!.id
		const result = await session.command({ type: "cells.set", sheet: one, cells: cells([[0, 0, "4"]]) })

		expect(result.ok).toBe(true)
		expect(tileTexts(await firstTile(session, one)).get("0,2")).toBe("12")

		const saved = await session.save()

		expect(saved.ok).toBe(true)
		host.dispose()
	})

	it("yields between slices of a long open", async () => {
		let pauses = 0
		let now = 0
		const rows = Array.from({ length: 3000 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join("")
		const host = inThreadSheetHost()
		const result = await host.open(
			buildFixture({ sheets: [{ name: "One", body: `<sheetData>${rows}</sheetData>` }] }),
			{
				kind: "xlsx",
				slicing: {
					sliceMs: 1,
					now: () => (now += 0.01),
					pause: () => {
						pauses++

						return Promise.resolve()
					}
				}
			},
			() => undefined
		)

		expect(result.kind).toBe("opened")
		expect(pauses).toBeGreaterThan(0)
		host.dispose()
	})

	it("opens text files as text", async () => {
		const host = inThreadSheetHost()
		const result = await host.open(new TextEncoder().encode("a,1\n"), { kind: "csv" }, () => undefined)

		expect(tileTexts(await firstTile(opened(result).session, 0)).get("0,1")).toBe("1")
		host.dispose()
	})
})

describe("worker sheet host", () => {
	it("runs a session in the worker: tiles, edits with patches, events and a transferred save", async () => {
		const { host, close } = workerPair()
		const events: SheetEvent[] = []
		const bytes = buildFixture(BASIC)
		const { session, info } = opened(await host.open(bytes, { kind: "xlsx" }, event => events.push(event)))

		// The bytes were handed over, not copied.
		expect(bytes.byteLength).toBe(0)

		const one = info.sheets[0]!.id
		const { tiles } = await session.tiles(one, Uint32Array.of(0, 0))

		expect(tileTexts(tiles[0]!).get("0,1")).toBe("hello")
		expect(await session.intent()).toEqual({ state: "writable" })

		const result = await session.command({ type: "cells.set", sheet: one, cells: cells([[0, 0, "10"]]) })

		expect(result.ok && tileTexts(result.change.patches[0]!).get("0,2")).toBe("30")

		const saved = await session.save()

		expect(saved.ok).toBe(true)
		expect(events.some(event => event.type === "writability")).toBe(true)

		session.close()
		host.dispose()
		close()
	})
})

describe("password-protected workbooks", () => {
	it("saves an unchanged workbook as the file's own bytes, an edit undone too", async () => {
		const file = await encryptedOfficeFile(agileStreams(buildFixture(BASIC), "secret"))
		const host = inThreadSheetHost()
		const result = await host.open(file.slice(), { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

		if (result.kind !== "needsPassword") throw new Error(result.kind)

		const unlocked = await result.locked.unlock("secret")

		if (!unlocked.ok) throw new Error(unlocked.reason)

		const untouched = await unlocked.session.save()

		if (!untouched.ok) throw new Error(untouched.message)

		expect(untouched.bytes).toEqual(file)

		const one = unlocked.info.sheets[0]!.id

		expect((await unlocked.session.command({ type: "cells.set", sheet: one, cells: cells([[0, 0, "8"]]) })).ok).toBe(true)
		expect((await unlocked.session.undo()).ok).toBe(true)

		const undone = await unlocked.session.save()

		if (!undone.ok) throw new Error(undone.message)

		expect(undone.bytes).toEqual(file)
		unlocked.session.close()
		host.dispose()
	})

	it("asks for the password, unlocks where the session runs and seals every save", async () => {
		const zip = buildFixture(BASIC)
		const file = await encryptedOfficeFile(agileStreams(zip, "secret"))
		const host = inThreadSheetHost()
		const result = await host.open(file, { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

		if (result.kind !== "needsPassword") throw new Error(`expected a password prompt, got ${result.kind}`)

		expect(await result.locked.unlock("wrong")).toEqual({ ok: false, reason: "wrongPassword" })

		const unlocked = await result.locked.unlock("secret")

		if (!unlocked.ok) throw new Error(unlocked.reason)

		expect(unlocked.info.encrypted).toBe("verified")

		const one = unlocked.info.sheets[0]!.id

		expect((await unlocked.session.command({ type: "cells.set", sheet: one, cells: cells([[0, 0, "8"]]) })).ok).toBe(true)

		const saved = await unlocked.session.save()

		if (!saved.ok) throw new Error(saved.message)

		expect(saved.encrypted).toBe(true)
		expect(sealed(saved.bytes)).toBe(true)
		unlocked.session.close()

		const again = await host.open(saved.bytes, { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

		if (again.kind !== "needsPassword") throw new Error("the save is not protected")

		const reopened = await again.locked.unlock("secret")

		if (!reopened.ok) throw new Error(reopened.reason)

		expect(tileTexts(await firstTile(reopened.session, reopened.info.sheets[0]!.id)).get("0,2")).toBe("24")
		reopened.session.close()
		host.dispose()
	})

	it("answers an unlock under way as aborted when the prompt is disposed, in a worker or on the thread", async () => {
		const file = await encryptedOfficeFile(agileStreams(buildFixture(BASIC), "secret"))
		const { host, close } = workerPair()
		const inWorker = await host.open(file.slice(), { kind: "xlsx" }, () => undefined)

		if (inWorker.kind !== "needsPassword") throw new Error(inWorker.kind)

		const unlocking = inWorker.locked.unlock("secret")

		inWorker.locked.dispose()
		expect(await unlocking).toEqual({ ok: false, reason: "aborted" })
		close()

		// On the thread: disposed while the unlocked workbook opens (past the unlock's own turns), the session it
		// opened is closed.
		let turns = 0
		let onTurn = (): void => undefined
		let time = 0
		const slicing = {
			sliceMs: 1,
			now: () => (time += 1),
			pause: () => {
				turns++
				onTurn()

				return Promise.resolve()
			}
		}
		const probe = await openProtectedWorkbook(bytesSource(file), undefined, slicing)

		if (probe.kind !== "needsPassword") throw new Error(probe.kind)

		const before = turns
		const unlocked = await probe.locked.unlock("secret", { slicing })

		if (!unlocked.ok) throw new Error(unlocked.reason)

		unlocked.document.release()

		const unlockTurns = turns - before
		const thread = inThreadSheetHost()
		const onThread = await thread.open(file, { kind: "xlsx", slicing }, () => undefined)

		if (onThread.kind !== "needsPassword") throw new Error(onThread.kind)

		const start = turns
		let closedAt = -1

		onTurn = () => {
			if (turns === start + unlockTurns + 1) {
				closedAt = turns
				onThread.locked.dispose()
			}
		}

		expect(await onThread.locked.unlock("secret")).toEqual({ ok: false, reason: "aborted" })
		expect(closedAt).toBeGreaterThan(0)
		thread.dispose()
	})

	it("answers an open under way as aborted when its worker host is disposed", async () => {
		const { host, close } = workerPair()
		const opening = host.open(buildFixture(BASIC), { kind: "xlsx" }, () => undefined)

		host.dispose()
		expect((await opening).kind).toBe("aborted")
		close()
	})

	it("opens a workbook encrypted with Excel's default password without asking", async () => {
		const file = await encryptedOfficeFile(agileStreams(buildFixture(BASIC), "VelvetSweatshop"))
		const result = await inThreadSheetHost().open(file, { kind: "xlsx", slicing: IMMEDIATE }, () => undefined)

		expect(opened(result).info.encrypted).toBe("verified")
		opened(result).session.close()
	})

	it("fails the save once the session closed and its key went, never handing out the zip", async () => {
		const file = await encryptedOfficeFile(agileStreams(buildFixture(BASIC), "VelvetSweatshop"))
		const { session } = opened(await inThreadSheetHost().open(file, { kind: "xlsx", slicing: IMMEDIATE }, () => undefined))
		const save = session.save()

		session.close()

		const result = await save

		expect(result.ok).toBe(false)
	})

	it("takes the package to another realm and gets the key only at the first seal", async () => {
		const file = await encryptedOfficeFile(agileStreams(buildFixture(BASIC), "secret"))
		const classified = await openProtectedWorkbook(bytesSource(file))

		if (classified.kind !== "needsPassword") throw new Error(classified.kind)

		const unlock = await classified.locked.unlock("secret")

		if (!unlock.ok) throw new Error(unlock.reason)

		const held = sheetUnlockedPackage(unlock.document)
		const taken = await held.take()
		let keys = 0
		const counted = {
			bytes: taken.bytes,
			key: (options?: { readonly signal?: { readonly aborted: boolean } }) => (keys++, taken.key(options))
		}
		const encryption = takenSheetEncryption(counted, held.integrity)
		const session = await openXlsxSession(bytesSource(taken.bytes), { kind: "xlsx", encryption }, () => undefined)

		held.dropPackage()

		if (session.kind !== "opened") throw new Error(session.kind)

		expect(keys).toBe(0)

		const saved = await session.session.save()

		expect(saved.ok && sealed(saved.bytes)).toBe(true)
		expect(keys).toBe(1)
		session.session.close()
		held.release()
	})
})
