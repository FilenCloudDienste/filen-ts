/**
 * Shared mock of @filen/shared for Vitest.
 *
 * Provides Semaphore and KeyedSemaphores (no-op) and run/runOrThrow (execute with defer support).
 *
 * Usage in test files:
 *
 *   vi.mock("@filen/shared", async () => await import("@/tests/mocks/filenShared"))
 *
 * To extend with additional exports:
 *
 *   vi.mock("@filen/shared", async () => ({
 *       ...await import("@/tests/mocks/filenShared"),
 *       formatBytes: vi.fn()
 *   }))
 */

import { vi } from "vitest"

export class Semaphore {
	async acquire(): Promise<void> {}
	release(): void {}
	async withPermit<T>(fn: () => Promise<T> | T): Promise<T> {
		return await fn()
	}
}

export class KeyedSemaphores {
	for(): Semaphore {
		return new Semaphore()
	}
	async acquire(): Promise<() => void> {
		return () => {}
	}
}

// Faithful to @filen/shared run(): ALWAYS resolves the full Result object on success —
// `throw: true` only changes the failure path (rethrow instead of a Failure result) —
// and runs deferred cleanups in REVERSE registration order (LIFO) inside a finally,
// exactly like the real implementation.
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
export async function run(fn: (defer: (cleanup: () => void) => void) => Promise<any>, opts?: { throw?: boolean }): Promise<any> {
	const cleanups: (() => void)[] = []

	const defer = (cleanup: () => void) => {
		cleanups.push(cleanup)
	}

	try {
		const data = await fn(defer)

		return { success: true, data, error: null }
	} catch (error) {
		if (opts?.throw) {
			throw error
		}

		return { success: false, data: null, error }
	} finally {
		for (let i = cleanups.length - 1; i >= 0; i--) {
			try {
				await cleanups[i]?.()
			} catch {}
		}
	}
}

export async function runOrThrow(fn: (defer: (cleanup: () => void) => void) => Promise<any>): Promise<any> {
	return (await run(fn, { throw: true })).data
}

export const createExecutableTimeout = vi.fn()

// InFlight, the drive-listing splice rules, isHiddenName, fileIconKey, the notes outbox helpers,
// partitionNotesByBucket, shareIdentityFromRole, the chat message segmentation pipeline and the copy
// job, progress and quota helpers, the remote-change rules, sanitizeFileName, convertTimestampToMs, errorMessage and CODE_FILE_EXTENSIONS are plain data helpers with no timing-sensitive behavior (unlike
// Semaphore's no-op above), so there is nothing to fake — pull them through vi.importActual, bypassing
// this factory's own interception of the bare specifier.
export const {
	InFlight,
	keepAgainstIncoming,
	upsertItem,
	removeByUuid,
	applyMembershipPatch,
	isHiddenName,
	fileIconKey,
	hashNoteContent,
	mergeInflight,
	buildInflightEntries,
	pruneAndRebaseNoteOutboxAfterPush,
	reconcileNoteOutboxAgainstCloud,
	noteBulkActionAvailability,
	partitionNotesByBucket,
	parsePlaylist,
	createPlaylist,
	renamePlaylist,
	addTracksToPlaylist,
	removeTracksFromPlaylist,
	reorderPlaylistFile,
	pruneDeadTracks,
	shareIdentityFromRole,
	segmentMessage,
	isEmojiOnly,
	upsertItems,
	createCopyJob,
	copyJobGlyph,
	applyCopyUpdate,
	settleCopyJob,
	isQuotaPreflightFailure,
	copyMaxBytes,
	copyJobPercent,
	isCopyJobRunning,
	copyJobRate,
	freeBytes,
	quotaVerdict,
	resolveQuotaVerdict,
	sumBytes,
	PushEchoes,
	isRevisionOf,
	decideRevision,
	settleHeldRevisions,
	conflictCopyStamp,
	conflictCopyName,
	sanitizeFileName,
	convertTimestampToMs,
	errorMessage,
	CODE_FILE_EXTENSIONS,
	isNoteOwner,
	hasNoteWriteAccess
} = await vi.importActual<typeof import("@filen/shared")>("@filen/shared")
