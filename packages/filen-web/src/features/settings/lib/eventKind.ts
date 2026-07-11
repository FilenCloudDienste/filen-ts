import {
	UploadIcon,
	HistoryIcon,
	RotateCcwIcon,
	FolderInputIcon,
	PencilIcon,
	Trash2Icon,
	UsersIcon,
	LinkIcon,
	FolderPlusIcon,
	PaletteIcon,
	LogInIcon,
	ShieldAlertIcon,
	KeyRoundIcon,
	ShieldCheckIcon,
	ShieldOffIcon,
	UserXIcon,
	MailIcon,
	TicketIcon,
	UserMinusIcon,
	StarIcon,
	CircleHelpIcon,
	type LucideIcon
} from "lucide-react"
import type { UserEventKind } from "@filen/sdk-rs"
import type { SettingsKey } from "@/lib/i18n"

interface EventKindMeta {
	labelKey: SettingsKey
	icon: LucideIcon
}

// WASM RENAME GOTCHA: the wasm UserEventKind union spells the two 2FA event kinds
// "twoFaEnabled"/"twoFaDisabled" (camelCase — a leading digit can't be a JS identifier, so
// wasm-bindgen renamed them off the server's own "2faEnabled"/"2faDisabled" strings). Mobile's
// TS-SDK binding keeps the server's original leading-digit spelling instead. Both keys are mapped to
// the SAME label here defensively — the wasm surface is the only one this app's UI ever sees today
// (getUserEvents comes straight from the worker seam), but a raw event string from anywhere else
// (a future socket push, a copy-pasted fixture) must resolve identically rather than silently
// falling into the "unknown" fallback below.
type LegacyTwoFaSpelling = "2faEnabled" | "2faDisabled"

// One map = the single source of truth for both the label and the icon per event kind, mirroring
// drive/lib/actionDefs.ts's ACTION_DEFS shape. `satisfies` checks every real wasm `UserEventKind`
// member is present (plus the two defensive legacy keys) while keeping each value's literal type.
export const EVENT_KIND_META = {
	fileUploaded: { labelKey: "settingsEventFileUploaded", icon: UploadIcon },
	fileVersioned: { labelKey: "settingsEventFileVersioned", icon: HistoryIcon },
	fileRestored: { labelKey: "settingsEventFileRestored", icon: RotateCcwIcon },
	versionedFileRestored: { labelKey: "settingsEventVersionedFileRestored", icon: RotateCcwIcon },
	fileMoved: { labelKey: "settingsEventFileMoved", icon: FolderInputIcon },
	fileRenamed: { labelKey: "settingsEventFileRenamed", icon: PencilIcon },
	fileMetadataChanged: { labelKey: "settingsEventFileMetadataChanged", icon: PencilIcon },
	fileTrash: { labelKey: "settingsEventFileTrash", icon: Trash2Icon },
	fileRm: { labelKey: "settingsEventFileRm", icon: Trash2Icon },
	fileShared: { labelKey: "settingsEventFileShared", icon: UsersIcon },
	fileLinkEdited: { labelKey: "settingsEventFileLinkEdited", icon: LinkIcon },
	deleteFilePermanently: { labelKey: "settingsEventDeleteFilePermanently", icon: Trash2Icon },
	folderTrash: { labelKey: "settingsEventFolderTrash", icon: Trash2Icon },
	folderShared: { labelKey: "settingsEventFolderShared", icon: UsersIcon },
	folderMoved: { labelKey: "settingsEventFolderMoved", icon: FolderInputIcon },
	folderRenamed: { labelKey: "settingsEventFolderRenamed", icon: PencilIcon },
	folderMetadataChanged: { labelKey: "settingsEventFolderMetadataChanged", icon: PencilIcon },
	subFolderCreated: { labelKey: "settingsEventSubFolderCreated", icon: FolderPlusIcon },
	baseFolderCreated: { labelKey: "settingsEventBaseFolderCreated", icon: FolderPlusIcon },
	folderRestored: { labelKey: "settingsEventFolderRestored", icon: RotateCcwIcon },
	folderColorChanged: { labelKey: "settingsEventFolderColorChanged", icon: PaletteIcon },
	deleteFolderPermanently: { labelKey: "settingsEventDeleteFolderPermanently", icon: Trash2Icon },
	login: { labelKey: "settingsEventLogin", icon: LogInIcon },
	failedLogin: { labelKey: "settingsEventFailedLogin", icon: ShieldAlertIcon },
	passwordChanged: { labelKey: "settingsEventPasswordChanged", icon: KeyRoundIcon },
	twoFaEnabled: { labelKey: "settingsEventTwoFaEnabled", icon: ShieldCheckIcon },
	twoFaDisabled: { labelKey: "settingsEventTwoFaDisabled", icon: ShieldOffIcon },
	requestAccountDeletion: { labelKey: "settingsEventRequestAccountDeletion", icon: UserXIcon },
	trashEmptied: { labelKey: "settingsEventTrashEmptied", icon: Trash2Icon },
	deleteAll: { labelKey: "settingsEventDeleteAll", icon: Trash2Icon },
	deleteVersioned: { labelKey: "settingsEventDeleteVersioned", icon: Trash2Icon },
	deleteUnfinished: { labelKey: "settingsEventDeleteUnfinished", icon: Trash2Icon },
	codeRedeemed: { labelKey: "settingsEventCodeRedeemed", icon: TicketIcon },
	emailChanged: { labelKey: "settingsEventEmailChanged", icon: MailIcon },
	emailChangeAttempt: { labelKey: "settingsEventEmailChangeAttempt", icon: MailIcon },
	removedSharedInItems: { labelKey: "settingsEventRemovedSharedInItems", icon: UserMinusIcon },
	removedSharedOutItems: { labelKey: "settingsEventRemovedSharedOutItems", icon: UserMinusIcon },
	folderLinkEdited: { labelKey: "settingsEventFolderLinkEdited", icon: LinkIcon },
	itemFavorite: { labelKey: "settingsEventItemFavorite", icon: StarIcon },
	// Defensive legacy spellings — see the WASM RENAME GOTCHA note above.
	"2faEnabled": { labelKey: "settingsEventTwoFaEnabled", icon: ShieldCheckIcon },
	"2faDisabled": { labelKey: "settingsEventTwoFaDisabled", icon: ShieldOffIcon }
} satisfies Record<UserEventKind["type"] | LegacyTwoFaSpelling, EventKindMeta>

const FALLBACK_ICON: LucideIcon = CircleHelpIcon

// Never crashes on a server event type this build doesn't know about yet: `type` arrives as a plain
// runtime string (same dynamic-key-under-a-typed-catalog gap as errorLabel.ts), so the lookup is cast
// through `Record<string, ...>` for the index access only — the map itself stays fully typed above.
export function eventKindMeta(type: string): EventKindMeta {
	const meta = (EVENT_KIND_META as Record<string, EventKindMeta | undefined>)[type]

	return meta ?? { labelKey: "settingsEventUnknown", icon: FALLBACK_ICON }
}
