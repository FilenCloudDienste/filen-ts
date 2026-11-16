import type { ErrorDTO } from "@/lib/sdk/errors"

export type WorkerGoneCause = "error" | "messageerror" | "terminated"

// A worker that broke under its users: crashed, could not deserialize a message, or died silently.
export class WorkerGoneError extends Error {
	public constructor(label: string, why: WorkerGoneCause) {
		super(`${label} worker is gone (${why})`)
		this.name = "WorkerGoneError"
	}
}

// A worker ended on purpose (its owner, its idle timeout, sign-out): calls still in flight reject with this, which callers
// treat as a cancellation.
export function workerEndedError(label: string, why: "ended by its owner" | "idle" | "released at sign-out"): DOMException {
	return new DOMException(`${label} worker ${why}`, "AbortError")
}

// What useOwnedWorker last published: the worker started for one key and attempt, and its failure once it broke.
export interface OwnedWorkerSession<Owned> {
	readonly key: string
	readonly attempt: number
	readonly generation: number
	readonly owned: Owned
	readonly failure: ErrorDTO | null
}

export type OwnedWorkerState<Owned> =
	| { status: "starting" }
	| { status: "ready"; owned: Owned; generation: number }
	| { status: "failed"; dto: ErrorDTO; restart: () => void }

// A session published for an earlier key or attempt is already terminated: until the current one is published, the
// worker is starting.
export function ownedWorkerState<Owned>(
	session: OwnedWorkerSession<Owned> | null,
	key: string,
	attempt: number,
	restart: () => void
): OwnedWorkerState<Owned> {
	if (session?.key !== key || session.attempt !== attempt) {
		return { status: "starting" }
	}

	if (session.failure !== null) {
		return { status: "failed", dto: session.failure, restart }
	}

	return { status: "ready", owned: session.owned, generation: session.generation }
}
