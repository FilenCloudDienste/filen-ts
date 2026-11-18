import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CALL_TIMEOUT_MS, createRpc } from "../main/native/rpc.ts"
import type { NativeCall } from "../shared/nativeProtocol.ts"

function harness() {
	const sent: NativeCall[] = []
	const rpc = createRpc(call => {
		sent.push(call)
	})

	return { rpc, sent }
}

describe("createRpc", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("a call with no reply resolves a timeout after its timeout", async () => {
		const { rpc } = harness()
		const onDefault = vi.fn()
		const onCustom = vi.fn()

		void rpc.call("listPairs", {}).then(onDefault)
		void rpc.call("listPairs", {}, 1_000).then(onCustom)

		await vi.advanceTimersByTimeAsync(999)
		expect(onCustom).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(onCustom).toHaveBeenCalledWith({ ok: false, error: { code: "timeout" } })

		await vi.advanceTimersByTimeAsync(CALL_TIMEOUT_MS - 1_001)
		expect(onDefault).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(onDefault).toHaveBeenCalledWith({ ok: false, error: { code: "timeout" } })
		expect(vi.getTimerCount()).toBe(0)
	})

	it("a reply after the timeout is dropped, not a broken host", async () => {
		const { rpc, sent } = harness()
		const onResult = vi.fn()

		void rpc.call("listPairs", {}, 1_000).then(onResult)
		await vi.advanceTimersByTimeAsync(1_000)
		expect(onResult).toHaveBeenCalledTimes(1)

		expect(rpc.settle({ t: "reply", id: sent[0]?.id ?? -1, ok: true, value: [] })).toBe(true)
		await vi.advanceTimersByTimeAsync(0)
		expect(onResult).toHaveBeenCalledTimes(1)
		expect(onResult).toHaveBeenCalledWith({ ok: false, error: { code: "timeout" } })
	})

	it("a send that throws resolves hostUnavailable and leaves nothing waiting", async () => {
		const rpc = createRpc(() => {
			throw new Error("channel closed")
		})

		expect(await rpc.call("listPairs", {})).toEqual({ ok: false, error: { code: "hostUnavailable" } })
		expect(vi.getTimerCount()).toBe(0)
		expect(rpc.settle({ t: "reply", id: 0, ok: true, value: "not pairs" })).toBe(true)
	})

	it("failAll answers every waiting call and clears its timer", async () => {
		const { rpc } = harness()
		const sync = rpc.call("listPairs", {})
		const mounts = rpc.callMounts("mountsStatus", {})

		expect(vi.getTimerCount()).toBe(2)
		rpc.failAll()

		expect(await sync).toEqual({ ok: false, error: { code: "hostUnavailable" } })
		expect(await mounts).toEqual({ ok: false, error: { code: "hostUnavailable" } })
		expect(vi.getTimerCount()).toBe(0)
	})

	it("replies arriving out of order reach their own calls", async () => {
		const { rpc, sent } = harness()
		const first = rpc.call("listPairs", {})
		const second = rpc.call("listPairs", {})
		const [firstId, secondId] = sent.map(call => call.id)

		expect(firstId).not.toBe(secondId)
		expect(rpc.settle({ t: "reply", id: secondId ?? -1, ok: false, error: { code: "pairNotFound" } })).toBe(true)
		expect(rpc.settle({ t: "reply", id: firstId ?? -1, ok: true, value: [] })).toBe(true)

		expect(await first).toEqual({ ok: true, value: [] })
		expect(await second).toEqual({ ok: false, error: { code: "pairNotFound" } })
		expect(vi.getTimerCount()).toBe(0)
	})
})
