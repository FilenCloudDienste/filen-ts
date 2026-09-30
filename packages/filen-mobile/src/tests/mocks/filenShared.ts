/**
 * Shared mock of @filen/shared for Vitest.
 *
 * Replaces Semaphore and KeyedSemaphores (no-ops) and createExecutableTimeout (spy); every other export
 * below is the real implementation.
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

export const createExecutableTimeout = vi.fn()

// Plain helpers with no timing-sensitive behavior (unlike Semaphore's no-op above), so there is nothing
// to fake — pull them through vi.importActual, bypassing this factory's own interception of the bare
// specifier.
export const {
	run,
	runOrThrow,
	runEffect,
	InFlight,
	upsertItem,
	applyMembershipPatch,
	ancestryHits,
	MAX_ANCESTRY_DEPTH,
	isHiddenName,
	fileIconKey,
	hashNoteContent,
	mergeInflight,
	buildInflightEntries,
	newestEntry,
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
	copyJobRate,
	resolveQuotaVerdict,
	sumBytes,
	PushEchoes,
	isRevisionOf,
	decideRevision,
	settleHeldRevisions,
	conflictCopyStamp,
	conflictCopyName,
	sanitizeFileName,
	errorMessage,
	validateUuid,
	CODE_FILE_EXTENSIONS,
	isNoteOwner,
	hasNoteWriteAccess,
	sortParams,
	driveItemName,
	planSizeCapEviction,
	dirColorHex,
	directoryFolderTint,
	compareChats,
	isListedChat,
	isOneOnOneWithBlocked,
	newestMessage,
	mergeInflightQueuesByUnion,
	isPermanentRejection,
	MAX_NON_RETRYABLE_REJECTIONS,
	createTypingSender
} = await vi.importActual<typeof import("@filen/shared")>("@filen/shared")
