import type {
	DesktopSyncError,
	DesktopSyncErrorCode,
	DesktopSyncRootProblem,
	DesktopSyncRootWarning,
	DesktopSyncUnsyncableReason
} from "@filen/shared/desktop"
import type { SyncKey } from "@/lib/i18n"

export const SYNC_ERROR_KEY: Record<DesktopSyncErrorCode, SyncKey> = {
	hostUnavailable: "errorHostUnavailable",
	timeout: "errorTimeout",
	unauthenticated: "errorUnauthenticated",
	pairNotFound: "errorPairNotFound",
	planExpired: "errorPlanExpired",
	rootExpired: "errorRootExpired",
	rootRefused: "errorRootRefused",
	accountRoot: "errorAccountRoot",
	localRootMissing: "errorLocalRootMissing",
	remoteRootMissing: "errorRemoteRootMissing",
	localRootInUse: "errorLocalRootInUse",
	localRootNested: "errorLocalRootNested",
	localRootContains: "errorLocalRootContains",
	remoteRootInUse: "errorRemoteRootInUse",
	remoteRootNested: "errorRemoteRootNested",
	remoteRootContains: "errorRemoteRootContains",
	modeConflict: "errorModeConflict",
	invalidIgnore: "errorInvalidIgnore",
	unknown: "errorUnknown"
}

export const ROOT_PROBLEM_KEY: Record<DesktopSyncRootProblem, SyncKey> = {
	notDirectory: "problemNotDirectory",
	notWritable: "problemNotWritable",
	filesystemRoot: "problemFilesystemRoot",
	homeDirectory: "problemHomeDirectory",
	appData: "problemAppData",
	temporary: "problemTemporary",
	insidePair: "problemInsidePair",
	containsPair: "problemContainsPair",
	insideMount: "problemInsideMount",
	containsMount: "problemContainsMount"
}

export const ROOT_WARNING_KEY: Record<DesktopSyncRootWarning, SyncKey> = {
	iCloud: "warningICloud",
	cloudStorage: "warningCloudStorage",
	oneDrive: "warningOneDrive"
}

export const UNSYNCABLE_REASON_KEY: Record<DesktopSyncUnsyncableReason, SyncKey> = {
	invalidName: "unsyncableInvalidName",
	repeatedFailure: "unsyncableRepeatedFailure",
	remoteUndecodable: "unsyncableRemoteUndecodable",
	remoteInvalidName: "unsyncableRemoteInvalidName",
	remoteBrokenParent: "unsyncableRemoteBrokenParent",
	localAlias: "unsyncableLocalAlias"
}

export function syncErrorKey(error: DesktopSyncError): SyncKey {
	return SYNC_ERROR_KEY[error.code]
}
