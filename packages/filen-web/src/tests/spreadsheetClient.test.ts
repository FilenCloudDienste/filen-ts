import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The spreadsheet worker's lifetime: kept while a document is open or a call is in flight, torn down once
// idle, and never reached by a call on a document that has closed. The worker and its Comlink proxy are
// plain fakes; spreadsheet.worker.ts itself is covered by the engine tests.

const { WorkerCtor, wrap, terminate, release, recoverIfNewerBuild } = vi.hoisted(() => ({
	recoverIfNewerBuild: vi.fn(),
	WorkerCtor: vi.fn(),
	wrap: vi.fn(),
	terminate: vi.fn(),
	release: vi.fn()
}))

vi.mock("@/features/spreadsheet/workers/spreadsheet.worker.ts?worker", () => ({ default: WorkerCtor }))
vi.mock("@/lib/appUpdate", () => ({ recoverIfNewerBuild }))
vi.mock("comlink", async importOriginal => ({ ...(await importOriginal<typeof import("comlink")>()), wrap }))

const IDLE_MS = 30_000
const DOC = { kind: "csv", sheets: [], activeSheet: 0, styles: [], writable: true }

interface FakeRemote {
	open: ReturnType<typeof vi.fn>
	close: ReturnType<typeof vi.fn>
	markSaved: ReturnType<typeof vi.fn>
}

let remotes: FakeRemote[] = []
// What every open waits on before it answers: settled unless a test holds it.
let openGate: Promise<unknown> = Promise.resolve()

async function freshClient() {
	vi.resetModules()

	const { releaseProxy } = await import("comlink")

	remotes = []
	openGate = Promise.resolve()
	WorkerCtor.mockReset()
	wrap.mockReset()
	terminate.mockReset()
	release.mockReset()
	recoverIfNewerBuild.mockReset()
	WorkerCtor.mockImplementation(function FakeWorker() {
		return Object.assign(new EventTarget(), { terminate })
	})
	wrap.mockImplementation(() => {
		// Like the real worker, each one numbers its documents from 1.
		let nextWorkerId = 1
		const remote: FakeRemote = {
			open: vi.fn(async () => {
				await openGate

				return { id: nextWorkerId++, doc: DOC }
			}),
			close: vi.fn(() => Promise.resolve()),
			markSaved: vi.fn((workerId: number) => Promise.resolve({ dirty: false, canUndo: false, canRedo: false, workerId }))
		}

		remotes.push(remote)

		return { ...remote, [releaseProxy]: release }
	})

	return await import("@/features/spreadsheet/lib/spreadsheetClient")
}

beforeEach(() => {
	vi.useFakeTimers()
})

afterEach(() => {
	vi.useRealTimers()
})

describe("spreadsheetClient", () => {
	it("keeps the worker while a document is open, and tears it down once idle after it closes", async () => {
		const client = await freshClient()
		const { id } = await client.openSpreadsheet(new Uint8Array([1]), "csv")

		await vi.advanceTimersByTimeAsync(IDLE_MS * 2)
		expect(terminate).not.toHaveBeenCalled()

		client.closeSpreadsheet(id)
		await vi.advanceTimersByTimeAsync(0)
		expect(remotes[0]?.close).toHaveBeenCalledExactlyOnceWith(1)
		expect(terminate).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(IDLE_MS)
		expect(release).toHaveBeenCalledOnce()
		expect(terminate).toHaveBeenCalledOnce()
	})

	it("checks for a newer build when the worker fails to start", async () => {
		const client = await freshClient()

		await client.openSpreadsheet(new Uint8Array([1]), "csv")

		const worker = WorkerCtor.mock.results[0]?.value as EventTarget | undefined

		expect(recoverIfNewerBuild).not.toHaveBeenCalled()
		worker?.dispatchEvent(new Event("error"))
		expect(recoverIfNewerBuild).toHaveBeenCalledOnce()
	})

	it("never tears the worker down under an open still parsing past the idle window", async () => {
		const client = await freshClient()
		let answer: () => void = () => undefined

		openGate = new Promise<void>(resolve => {
			answer = resolve
		})

		const pending = client.openSpreadsheet(new Uint8Array([1]), "csv")

		await vi.advanceTimersByTimeAsync(IDLE_MS * 2)
		expect(terminate).not.toHaveBeenCalled()

		answer()

		const { id } = await pending

		client.closeSpreadsheet(id)
		await vi.advanceTimersByTimeAsync(IDLE_MS)
		expect(terminate).toHaveBeenCalledOnce()
	})

	it("rejects a call on a closed document without spinning up a worker", async () => {
		const client = await freshClient()
		const { id } = await client.openSpreadsheet(new Uint8Array([1]), "csv")

		client.closeSpreadsheet(id)
		await vi.advanceTimersByTimeAsync(IDLE_MS)
		expect(terminate).toHaveBeenCalledOnce()

		const run = vi.fn(() => Promise.resolve())

		await expect(client.withOpenSpreadsheet(id, run)).rejects.toThrow("no open document")
		expect(run).not.toHaveBeenCalled()
		expect(WorkerCtor).toHaveBeenCalledOnce()
	})

	it("never lets a closed document's id reach a newer worker's document of the same worker id", async () => {
		const client = await freshClient()
		const first = await client.openSpreadsheet(new Uint8Array([1]), "csv")

		client.closeSpreadsheet(first.id)
		await vi.advanceTimersByTimeAsync(IDLE_MS)

		const second = await client.openSpreadsheet(new Uint8Array([2]), "csv")

		// Both workers numbered their document 1; the ids handed out differ.
		expect(WorkerCtor).toHaveBeenCalledTimes(2)
		expect(second.id).not.toBe(first.id)

		await expect(client.withOpenSpreadsheet(first.id, (remote, workerId) => remote.markSaved(workerId, 1))).rejects.toThrow(
			"no open document"
		)
		expect(remotes[1]?.markSaved).not.toHaveBeenCalled()

		await client.withOpenSpreadsheet(second.id, (remote, workerId) => remote.markSaved(workerId, 1))
		expect(remotes[1]?.markSaved).toHaveBeenCalledExactlyOnceWith(1, 1)
	})

	it("keeps the worker for a call still in flight when its document closes", async () => {
		const client = await freshClient()
		const { id } = await client.openSpreadsheet(new Uint8Array([1]), "csv")
		let answer: (value: unknown) => void = () => undefined

		remotes[0]?.markSaved.mockReturnValueOnce(
			new Promise(resolve => {
				answer = resolve
			})
		)

		const saving = client.withOpenSpreadsheet(id, (remote, workerId) => remote.markSaved(workerId, 1))

		client.closeSpreadsheet(id)
		await vi.advanceTimersByTimeAsync(IDLE_MS * 2)
		expect(terminate).not.toHaveBeenCalled()

		answer({ dirty: false, canUndo: false, canRedo: false })
		await saving
		await vi.advanceTimersByTimeAsync(IDLE_MS)
		expect(terminate).toHaveBeenCalledOnce()
	})

	it("runs a one-off call in its own use, disposed once idle", async () => {
		const client = await freshClient()

		await client.withSpreadsheetWorker(() => Promise.resolve())
		expect(terminate).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(IDLE_MS)
		expect(terminate).toHaveBeenCalledOnce()
	})
})
