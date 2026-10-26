import { type, type Type } from "arktype"
import type { DesktopSyncResult } from "@filen/shared/desktop"
import {
	type FromNative,
	type NativeCall,
	type NativeOp,
	type NativeOpArgs,
	type NativeOpResult,
	opResult
} from "../../shared/nativeProtocol.ts"

export const CALL_TIMEOUT_MS = 120_000

export type NativeReply = Extract<FromNative, { t: "reply" }>

export type NativeResult<K extends NativeOp> = DesktopSyncResult<NativeOpResult<K>>

export interface NativeRpc {
	call<K extends NativeOp>(op: K, args: NativeOpArgs<K>, timeoutMs?: number): Promise<NativeResult<K>>
	// false: the value is not what the call returns, so the host is broken. A reply nothing waits for (its call timed
	// out) is dropped.
	settle(reply: NativeReply): boolean
	// Answers every waiting call with `hostUnavailable`: the host is gone.
	failAll(): void
}

interface Waiting {
	op: NativeOp
	resolve: (result: DesktopSyncResult<unknown>) => void
	timer: NodeJS.Timeout
}

// Calls to one host process, matched to replies by id. A call never rejects: a lost host or a timeout is an error
// result like any other.
export function createRpc(send: (call: NativeCall) => void): NativeRpc {
	let nextId = 0
	const waiting = new Map<number, Waiting>()

	return {
		call: (op, args, timeoutMs = CALL_TIMEOUT_MS) => {
			const id = nextId++

			return new Promise(resolve => {
				const timer = setTimeout(() => {
					waiting.delete(id)
					resolve({ ok: false, error: { code: "timeout" } })
				}, timeoutMs)

				waiting.set(id, { op, resolve: resolve as Waiting["resolve"], timer })

				try {
					send({ t: "call", id, op, args } as NativeCall)
				} catch {
					clearTimeout(timer)
					waiting.delete(id)
					resolve({ ok: false, error: { code: "hostUnavailable" } })
				}
			})
		},
		settle: reply => {
			const entry = waiting.get(reply.id)

			if (entry === undefined) {
				return true
			}

			waiting.delete(reply.id)
			clearTimeout(entry.timer)

			if (!reply.ok) {
				entry.resolve({ ok: false, error: reply.error })

				return true
			}

			const result: Type<unknown> = opResult(entry.op)
			const value = result(reply.value)

			if (value instanceof type.errors) {
				entry.resolve({ ok: false, error: { code: "hostUnavailable" } })

				return false
			}

			entry.resolve({ ok: true, value })

			return true
		},
		failAll: () => {
			for (const entry of waiting.values()) {
				clearTimeout(entry.timer)
				entry.resolve({ ok: false, error: { code: "hostUnavailable" } })
			}

			waiting.clear()
		}
	}
}
