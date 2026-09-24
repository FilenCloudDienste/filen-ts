import { AnyDirWithContext, type AnyNormalDir, type DirsAndFilesWithPaths } from "@filen/sdk-rs"
import auth from "@/lib/auth"

// Long enough for a sync that starts right after the Photos grid refetched (pull-to-refresh, reconnect)
// to take over that walk; short enough that nothing holds a large listing around.
export const SETTLED_REUSE_MS = 10_000

export type CameraUploadRemoteListing = {
	listing: DirsAndFilesWithPaths
	// Entries under an errored subtree are absent from `listing`, and errors can still arrive after
	// the walk resolved, so consumers must read this array rather than copy it.
	scanErrors: unknown[]
}

type Walk = {
	rootUuid: string
	sequence: number
	settledAt: number | null
	consumers: number
	controller: AbortController
	promise: Promise<CameraUploadRemoteListing>
}

let latest: Walk | null = null
let walksStarted = 0
// Roots whose last walk dropped entries (scan errors). Session-only: the Photos grid lists those
// plainly instead of paying for a with-paths walk it would have to redo.
const degradedRoots = new Set<string>()

export function remoteWalkDropsEntries(rootUuid: string): boolean {
	return degradedRoots.has(rootUuid)
}

// A point in the walk sequence (a counter, not a clock, so two walks in one millisecond still
// order): only walks started after it may be taken over.
export function remoteListingPosition(): number {
	return walksStarted
}

function startWalk(remoteDir: AnyNormalDir): Walk {
	const rootUuid = remoteDir.inner[0].uuid
	const controller = new AbortController()
	const scanErrors: unknown[] = []
	const promise = (async () => {
		const { authedSdkClient } = await auth.getSdkClients()
		const listing = await authedSdkClient.listDirRecursiveWithPaths(
			new AnyDirWithContext.Normal(remoteDir),
			undefined,
			{
				onErrors(errors) {
					scanErrors.push(...errors)
					degradedRoots.add(rootUuid)
				}
			},
			{
				signal: controller.signal
			}
		)

		return {
			listing,
			scanErrors
		}
	})()
	const walk: Walk = {
		rootUuid,
		sequence: ++walksStarted,
		settledAt: null,
		consumers: 0,
		controller,
		promise
	}

	promise.then(
		result => {
			walk.settledAt = Date.now()

			if (result.scanErrors.length === 0) {
				degradedRoots.delete(rootUuid)
			}

			setTimeout(() => {
				if (latest === walk) {
					latest = null
				}
			}, SETTLED_REUSE_MS)
		},
		() => {
			if (latest === walk) {
				latest = null
			}
		}
	)

	return walk
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Aborted")
}

// The walk keeps running for its other consumers; only this caller stops waiting.
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) {
		return promise
	}

	if (signal.aborted) {
		return Promise.reject(abortReason(signal))
	}

	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortReason(signal))

		signal.addEventListener("abort", onAbort, { once: true })

		promise.then(
			value => {
				signal.removeEventListener("abort", onAbort)
				resolve(value)
			},
			error => {
				signal.removeEventListener("abort", onAbort)
				reject(error)
			}
		)
	})
}

/**
 * One recursive walk of the camera-upload root, shared by the Photos grid and camera upload's delta
 * pass (the with-paths call is the same single request as the plain one, plus the paths the delta
 * keys need).
 *
 * `since` (a remoteListingPosition) opts into taking over the latest walk if it started after that
 * point, in flight or settled within SETTLED_REUSE_MS: a sync passes the position at its own start,
 * so the listing is never older than the one it would have fetched itself. Without it (the grid) a
 * fresh walk always starts, since a refetch must not return a listing older than the request.
 */
export async function listCameraUploadRemote({
	remoteDir,
	signal,
	since
}: {
	remoteDir: AnyNormalDir
	signal?: AbortSignal
	since?: number
}): Promise<CameraUploadRemoteListing> {
	const reusable =
		latest !== null &&
		since !== undefined &&
		latest.rootUuid === remoteDir.inner[0].uuid &&
		latest.sequence > since &&
		(latest.settledAt === null || Date.now() - latest.settledAt <= SETTLED_REUSE_MS)
			? latest
			: null
	const walk = reusable ?? startWalk(remoteDir)

	if (!reusable) {
		latest = walk
	}

	walk.consumers++

	try {
		return await untilAborted(walk.promise, signal)
	} finally {
		walk.consumers--

		// The last waiter gave up before the walk finished: nobody needs the result.
		if (walk.consumers === 0 && walk.settledAt === null && signal?.aborted) {
			walk.controller.abort()

			if (latest === walk) {
				latest = null
			}
		}
	}
}
