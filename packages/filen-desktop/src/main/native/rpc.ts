import { type, type Type } from "arktype"
import type { DesktopMountsError, DesktopMountsResult, DesktopSyncError, DesktopSyncResult } from "@filen/shared/desktop"
import {
	type FromNative,
	type MountsOp,
	type NativeCall,
	type NativeOp,
	type NativeOpArgs,
	type NativeOpResult,
	opError,
	opResult,
	type SyncOp
} from "../../shared/nativeProtocol.ts"

export const CALL_TIMEOUT_MS = 120_000

export type NativeReply = Extract<FromNative, { t: "reply" }>

export type NativeResult<K extends SyncOp> = DesktopSyncResult<NativeOpResult<K>>

export type NativeMountsResult<K extends MountsOp> = DesktopMountsResult<NativeOpResult<K>>

// Either family's result, before it is narrowed to the op's own.
type AnyResult = { ok: true; value: unknown } | { ok: false; error: DesktopSyncError | DesktopMountsError }

export interface NativeRpc {
	call<K extends SyncOp>(op: K, args: NativeOpArgs<K>, timeoutMs?: number): Promise<NativeResult<K>>
	callMounts<K extends MountsOp>(op: K, args: NativeOpArgs<K>, timeoutMs?: number): Promise<NativeMountsResult<K>>
	// false: the value is not what the call returns, so the host is broken. A reply nothing waits for (its call timed
	// out) is dropped.
	settle(reply: NativeReply): boolean
	// Answers every waiting call with `hostUnavailable`: the host is gone.
	failAll(): void
}

interface Waiting {
	op: NativeOp
	resolve: (result: AnyResult) => void
	timer: NodeJS.Timeout
}

// Calls to one host process, matched to replies by id. A call never rejects: a lost host or a timeout is an error
// result like any other.
export function createRpc(send: (call: NativeCall) => void): NativeRpc {
	let nextId = 0
	const waiting = new Map<number, Waiting>()

	// settle checks the reply against the op, so its result is the op's own.
	function request(op: NativeOp, args: unknown, timeoutMs: number): Promise<AnyResult> {
		const id = nextId++

		return new Promise(resolve => {
			const timer = setTimeout(() => {
				waiting.delete(id)
				resolve({ ok: false, error: { code: "timeout" } })
			}, timeoutMs)

			waiting.set(id, { op, resolve, timer })

			try {
				send({ t: "call", id, op, args } as NativeCall)
			} catch {
				clearTimeout(timer)
				waiting.delete(id)
				resolve({ ok: false, error: { code: "hostUnavailable" } })
			}
		})
	}

	return {
		call: <K extends SyncOp>(op: K, args: NativeOpArgs<K>, timeoutMs = CALL_TIMEOUT_MS) =>
			request(op, args, timeoutMs) as Promise<NativeResult<K>>,
		callMounts: <K extends MountsOp>(op: K, args: NativeOpArgs<K>, timeoutMs = CALL_TIMEOUT_MS) =>
			request(op, args, timeoutMs) as Promise<NativeMountsResult<K>>,
		settle: reply => {
			const entry = waiting.get(reply.id)

			if (entry === undefined) {
				return true
			}

			waiting.delete(reply.id)
			clearTimeout(entry.timer)

			if (!reply.ok) {
				const error: Type<unknown> = opError(entry.op)

				// An error the op cannot report (a sync code for a mounts call) is a broken host like a wrong value.
				if (error(reply.error) instanceof type.errors) {
					entry.resolve({ ok: false, error: { code: "hostUnavailable" } })

					return false
				}

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
