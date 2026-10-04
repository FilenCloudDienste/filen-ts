import type { ParseKeys, TFunction } from "i18next"
import type { DirColor, DirMeta, FileMeta, UserEventKind } from "@filen/sdk-rs"
import {
	USER_AGENT_MAX_LENGTH,
	deviceLabel,
	dirColorHex,
	formatBytes,
	isNamedDirColor,
	isValidHexColor,
	parseUserAgent,
	type NamedDirColor,
	type ParsedUserAgent
} from "@filen/shared"
import { fileIconKey, type FileIconKey } from "@/features/drive/lib/icon.logic"
import type { EventEntry } from "@/features/settings/lib/eventsPagination"
import type { DriveKey, EventsKey } from "@/lib/i18n"
import { MISLEADING_CHARACTER } from "@/lib/sdk/archiveListing"

// The pure model behind Settings → Events: what each event is (category, sentence, tone, icon), the
// row's second line, search text, day grouping, new-device detection and the security summary. Every
// lookup it needs from the app's caches arrives through EventModelContext, so it runs without requests.

export type EventCategory = "files" | "directories" | "sharing" | "security" | "account"

export const EVENT_CATEGORIES = ["files", "directories", "sharing", "security", "account"] as const satisfies readonly EventCategory[]

export type EventTone = "default" | "warning" | "danger"

// A glyph per action, mapped to an icon by the UI.
export type EventIconKey =
	| "upload"
	| "version"
	| "restore"
	| "move"
	| "rename"
	| "edit"
	| "trash"
	| "delete"
	| "share"
	| "unshare"
	| "link"
	| "createDirectory"
	| "color"
	| "favorite"
	| "unfavorite"
	| "signIn"
	| "failedSignIn"
	| "password"
	| "twoFactorOn"
	| "twoFactorOff"
	| "accountDeletion"
	| "email"
	| "code"
	| "unknown"

type KindType = UserEventKind["type"]

type OkEntry = Extract<EventEntry, { type: "ok" }>

const KIND_CATEGORY = {
	fileUploaded: "files",
	fileVersioned: "files",
	fileRestored: "files",
	versionedFileRestored: "files",
	fileMoved: "files",
	fileRenamed: "files",
	fileMetadataChanged: "files",
	fileTrash: "files",
	fileRm: "files",
	deleteFilePermanently: "files",
	trashEmptied: "files",
	deleteAll: "files",
	deleteVersioned: "files",
	deleteUnfinished: "files",
	itemFavorite: "files",
	folderTrash: "directories",
	folderMoved: "directories",
	folderRenamed: "directories",
	folderMetadataChanged: "directories",
	subFolderCreated: "directories",
	baseFolderCreated: "directories",
	folderRestored: "directories",
	folderColorChanged: "directories",
	deleteFolderPermanently: "directories",
	fileShared: "sharing",
	fileLinkEdited: "sharing",
	folderShared: "sharing",
	folderLinkEdited: "sharing",
	removedSharedInItems: "sharing",
	removedSharedOutItems: "sharing",
	login: "security",
	failedLogin: "security",
	passwordChanged: "security",
	twoFaEnabled: "security",
	twoFaDisabled: "security",
	requestAccountDeletion: "account",
	emailChanged: "account",
	emailChangeAttempt: "account",
	codeRedeemed: "account"
} as const satisfies Record<KindType, EventCategory>

// The server's own spelling of the two kinds the SDK renames.
const RAW_KIND_TYPES: Readonly<Record<string, KindType>> = {
	"2faEnabled": "twoFaEnabled",
	"2faDisabled": "twoFaDisabled"
}

function knownKindType(type: string | undefined): KindType | undefined {
	if (type === undefined) {
		return undefined
	}

	const renamed = RAW_KIND_TYPES[type]

	if (renamed !== undefined) {
		return renamed
	}

	return Object.hasOwn(KIND_CATEGORY, type) ? (type as KindType) : undefined
}

export function eventCategory(kind: UserEventKind): EventCategory {
	if (kind.type === "itemFavorite") {
		return kind.itemType === "folder" ? "directories" : "files"
	}

	return KIND_CATEGORY[kind.type]
}

// An undecodable event still files under its category when its raw type is one this build knows.
export function entryCategory(entry: EventEntry): EventCategory | undefined {
	if (entry.type === "ok") {
		return eventCategory(entry.event.kind)
	}

	const type = knownKindType(entry.raw.type)

	return type === undefined ? undefined : KIND_CATEGORY[type]
}

function kindTone(type: KindType | undefined): EventTone {
	switch (type) {
		case "failedLogin":
			return "danger"

		case "passwordChanged":
		case "twoFaEnabled":
		case "twoFaDisabled":
		case "emailChanged":
		case "emailChangeAttempt":
		case "requestAccountDeletion":
			return "warning"

		default:
			return "default"
	}
}

// ── Item metadata ────────────────────────────────────────────────────────────

// What an event's item metadata says. The file key is never read out.
export interface EventItemMeta {
	name?: string
	mime?: string
	size?: number
	// Milliseconds.
	modified?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
		return value
	}

	if (typeof value === "string" && /^\d+$/.test(value)) {
		return Number(value)
	}

	return undefined
}

// Raw metadata JSON: a legacy file's (`lastModified`) or a directory's, whatever the SDK could not decode.
function jsonMeta(text: string): EventItemMeta {
	let value: unknown

	try {
		value = JSON.parse(text)
	} catch {
		return {}
	}

	if (!isRecord(value)) {
		return {}
	}

	const meta: EventItemMeta = {}
	const name = value["name"]
	const mime = value["mime"]
	const size = finiteNumber(value["size"])
	const modified = finiteNumber(value["lastModified"] ?? value["modified"])

	if (typeof name === "string" && name.length > 0) {
		meta.name = name
	}

	if (typeof mime === "string" && mime.length > 0) {
		meta.mime = mime
	}

	if (size !== undefined) {
		meta.size = size
	}

	if (modified !== undefined && modified > 0) {
		meta.modified = modified
	}

	return meta
}

const utf8 = new TextDecoder()

function rawMeta(bytes: number[]): EventItemMeta {
	return jsonMeta(utf8.decode(Uint8Array.from(bytes)))
}

export function fileMetaFields(meta: FileMeta | undefined): EventItemMeta {
	switch (meta?.type) {
		case "decoded": {
			const fields: EventItemMeta = { name: meta.data.name, mime: meta.data.mime, size: Number(meta.data.size) }
			const modified = Number(meta.data.modified)

			if (modified > 0) {
				fields.modified = modified
			}

			return fields
		}

		case "decryptedUTF8":
			return jsonMeta(meta.data)

		case "decryptedRaw":
			return rawMeta(meta.data)

		default:
			return {}
	}
}

export function dirMetaName(meta: DirMeta | undefined): string | undefined {
	switch (meta?.type) {
		case "decoded":
			return meta.data.name

		case "decryptedUTF8":
			return jsonMeta(meta.data).name

		case "decryptedRaw":
			return rawMeta(meta.data).name

		default:
			return undefined
	}
}

// ── Context ──────────────────────────────────────────────────────────────────

export interface EventContact {
	name: string
	avatar?: string
}

// The app's caches, read without requests. `directoryName` and `contact` return undefined on a miss.
export interface EventModelContext {
	t: TFunction<["events", "drive"]>
	directoryName: (uuid: string) => string | undefined
	contact: (email: string) => EventContact | undefined
	rootUuid: string | undefined
}

// ── Description ──────────────────────────────────────────────────────────────

export interface EventItemRef {
	type: "file" | "directory"
	uuid?: string
	stableUuid?: string
	parent?: string
	// `uuid` names an archived version that is gone, with no id of the file that stands.
	versionOnly?: true
}

export type EventTitleKey = ParseKeys<"events">

export interface EventTitleValues {
	name?: string
	oldName?: string
	newName?: string
	email?: string
	count?: number
	code?: string
	type?: string
}

export interface EventDescription {
	category: EventCategory | undefined
	icon: EventIconKey
	// The item's file-type glyph, for file events whose name or mime is readable.
	fileIcon?: FileIconKey
	tone: EventTone
	titleKey: EventTitleKey
	values: EventTitleValues
	title: string
	item?: EventItemRef
	meta?: EventItemMeta
	// The item's directory, from the caches only.
	location?: string
	device: ParsedUserAgent
	deviceLabel: string
	ip?: string
	userAgent?: string
	// The row's second line, in order: location, size, device (and the IP for security and undecodable
	// events).
	secondary: string[]
	// A readable name holds an invisible or direction-changing character.
	misleading?: true
}

// Every event of an account repeats a handful of user agents: parse each once. Least recently used first,
// so a run of distinct (hostile) ones evicts one entry each instead of the whole cache. Keyed by what the
// parser reads, so a long one costs no more memory than that.
const USER_AGENT_CACHE_MAX = 64
const userAgentCache = new Map<string, ParsedUserAgent>()

export function parseEventUserAgent(ua: string | undefined): ParsedUserAgent {
	const key = ua === undefined ? "" : ua.length > USER_AGENT_MAX_LENGTH ? ua.slice(0, USER_AGENT_MAX_LENGTH) : ua
	let parsed = userAgentCache.get(key)

	if (parsed !== undefined) {
		userAgentCache.delete(key)
		userAgentCache.set(key, parsed)

		return parsed
	}

	parsed = parseUserAgent(key)

	if (userAgentCache.size >= USER_AGENT_CACHE_MAX) {
		const eldest = userAgentCache.keys().next()

		if (eldest.done !== true) {
			userAgentCache.delete(eldest.value)
		}
	}

	userAgentCache.set(key, parsed)

	return parsed
}

export function eventDeviceLabel(parsed: ParsedUserAgent, t: EventModelContext["t"]): string {
	return deviceLabel(parsed, {
		browserOnOs: (browser, os) => t("eventsDeviceOnOs", { browser, os }),
		unknown: t("eventsDeviceUnknown")
	})
}

function directoryLabel(uuid: string | undefined, ctx: EventModelContext): string | undefined {
	if (uuid === undefined) {
		return undefined
	}

	return uuid === ctx.rootUuid ? ctx.t("drive:driveMyDrive") : ctx.directoryName(uuid)
}

function emailLabel(email: string, ctx: EventModelContext): string {
	return ctx.contact(email)?.name ?? email
}

function fileItem(uuid: string | undefined, stableUuid: string | undefined, parent: string | undefined): EventItemRef {
	const ref: EventItemRef = { type: "file" }

	if (uuid !== undefined) {
		ref.uuid = uuid
	}

	if (stableUuid !== undefined) {
		ref.stableUuid = stableUuid
	}

	if (parent !== undefined) {
		ref.parent = parent
	}

	return ref
}

function directoryItem(uuid: string | undefined, parent: string | undefined): EventItemRef {
	const ref: EventItemRef = { type: "directory" }

	if (uuid !== undefined) {
		ref.uuid = uuid
	}

	if (parent !== undefined) {
		ref.parent = parent
	}

	return ref
}

// What a kind contributes beyond the fields every event shares.
interface KindParts {
	icon: EventIconKey
	titleKey: EventTitleKey
	values: EventTitleValues
	item?: EventItemRef
	meta?: EventItemMeta
	fileIcon?: FileIconKey
	locationVerb?: "in" | "to"
}

function renameParts(oldName: string | undefined, newName: string | undefined, renamedKind: boolean, fallback: string): KindParts {
	// Equal names: only other metadata changed, whatever the kind says.
	const renamed = oldName !== undefined && newName !== undefined ? oldName !== newName : renamedKind

	return renamed
		? { icon: "rename", titleKey: "eventsTitleRenamed", values: { oldName: oldName ?? fallback, newName: newName ?? fallback } }
		: { icon: "edit", titleKey: "eventsTitleUpdated", values: { name: newName ?? oldName ?? fallback } }
}

function fileParts(meta: EventItemMeta, fallback: string): { name: string; meta: EventItemMeta; fileIcon: FileIconKey } {
	return {
		name: meta.name ?? fallback,
		meta,
		fileIcon: fileIconKey(meta.name ?? "", meta.mime)
	}
}

function kindParts(kind: UserEventKind, ctx: EventModelContext): KindParts {
	const fileFallback = ctx.t("eventsFallbackFile")
	const directoryFallback = ctx.t("eventsFallbackDirectory")

	switch (kind.type) {
		case "fileUploaded":
		case "fileRestored":
		case "versionedFileRestored":
		case "fileMoved":
		case "fileRm": {
			const { name, meta, fileIcon } = fileParts(fileMetaFields(kind.metadata), fileFallback)
			const byKind = {
				fileUploaded: ["upload", "eventsTitleUploaded"],
				fileRestored: ["restore", "eventsTitleRestoredFromTrash"],
				versionedFileRestored: ["restore", "eventsTitleRestoredOlderVersion"],
				fileMoved: ["move", "eventsTitleMoved"],
				fileRm: ["delete", "eventsTitleDeleted"]
			} as const satisfies Record<string, readonly [EventIconKey, EventTitleKey]>
			const [icon, titleKey] = byKind[kind.type]

			return {
				icon,
				titleKey,
				values: { name },
				item: fileItem(kind.uuid, kind.stableUuid, kind.parent),
				meta,
				fileIcon,
				locationVerb: kind.type === "fileMoved" ? "to" : "in"
			}
		}

		case "fileVersioned": {
			const { name, meta, fileIcon } = fileParts(fileMetaFields(kind.metadata), fileFallback)

			// `uuid` is the superseded file; the successor is current.
			return {
				icon: "version",
				titleKey: "eventsTitleNewVersion",
				values: { name },
				item: fileItem(kind.newUuid ?? kind.uuid, kind.stableUuid, kind.parent),
				meta,
				fileIcon,
				locationVerb: "in"
			}
		}

		case "fileTrash": {
			const { name, meta, fileIcon } = fileParts(fileMetaFields(kind.metadata), fileFallback)

			// With versioning off, an edit retires the old file into the trash under `newUuid`'s successor.
			return kind.newUuid !== undefined
				? {
						icon: "version",
						titleKey: "eventsTitleReplaced",
						values: { name },
						item: fileItem(kind.newUuid, undefined, kind.parent),
						meta,
						fileIcon,
						locationVerb: "in"
					}
				: {
						icon: "trash",
						titleKey: "eventsTitleTrashed",
						values: { name },
						item: fileItem(kind.uuid, kind.stableUuid, kind.parent),
						meta,
						fileIcon,
						locationVerb: "in"
					}
		}

		case "deleteFilePermanently": {
			const { name, meta, fileIcon } = fileParts(fileMetaFields(kind.metadata), fileFallback)
			// A uuid without a stable id: only archived versions died and the file stands. Legacy events carry
			// neither.
			const oldVersionsOnly = kind.uuid !== undefined && kind.stableUuid === undefined
			const item = fileItem(kind.uuid, kind.stableUuid, kind.parent)

			if (oldVersionsOnly) {
				item.versionOnly = true
			}

			return {
				icon: "delete",
				titleKey: oldVersionsOnly ? "eventsTitleDeletedOldVersions" : "eventsTitleDeletedPermanently",
				values: { name },
				item,
				meta,
				fileIcon,
				locationVerb: "in"
			}
		}

		case "fileRenamed":
		case "fileMetadataChanged": {
			const meta = fileMetaFields(kind.metadata)
			const oldMeta = fileMetaFields(kind.oldMetadata)

			return {
				...renameParts(oldMeta.name, meta.name, kind.type === "fileRenamed", fileFallback),
				item: fileItem(kind.uuid, kind.stableUuid, undefined),
				meta,
				fileIcon: fileIconKey(meta.name ?? oldMeta.name ?? "", meta.mime ?? oldMeta.mime)
			}
		}

		case "fileShared": {
			const { name, meta, fileIcon } = fileParts(fileMetaFields(kind.metadata), fileFallback)

			return {
				icon: "share",
				titleKey: "eventsTitleShared",
				values: { name, email: emailLabel(kind.receiverEmail, ctx) },
				item: fileItem(kind.uuid, undefined, kind.parent),
				meta,
				fileIcon,
				locationVerb: "in"
			}
		}

		case "fileLinkEdited": {
			const { name, meta, fileIcon } = fileParts(fileMetaFields(kind.metadata), fileFallback)

			return {
				icon: "link",
				titleKey: "eventsTitleLinkChanged",
				values: { name },
				item: fileItem(kind.uuid, undefined, undefined),
				meta,
				fileIcon
			}
		}

		case "folderTrash":
		case "folderMoved":
		case "subFolderCreated":
		case "baseFolderCreated":
		case "folderRestored":
		case "deleteFolderPermanently": {
			const byKind = {
				folderTrash: ["trash", "eventsTitleTrashed"],
				folderMoved: ["move", "eventsTitleMoved"],
				subFolderCreated: ["createDirectory", "eventsTitleCreated"],
				baseFolderCreated: ["createDirectory", "eventsTitleCreated"],
				folderRestored: ["restore", "eventsTitleRestoredFromTrash"],
				deleteFolderPermanently: ["delete", "eventsTitleDeletedPermanently"]
			} as const satisfies Record<string, readonly [EventIconKey, EventTitleKey]>
			const [icon, titleKey] = byKind[kind.type]
			const name = dirMetaName(kind.name)

			return {
				icon,
				titleKey,
				values: { name: name ?? directoryFallback },
				item: directoryItem(kind.uuid, kind.parent),
				meta: name === undefined ? {} : { name },
				locationVerb: kind.type === "folderMoved" ? "to" : "in"
			}
		}

		case "folderRenamed":
		case "folderMetadataChanged": {
			const name = dirMetaName(kind.name)

			return {
				...renameParts(dirMetaName(kind.oldName), name, kind.type === "folderRenamed", directoryFallback),
				item: directoryItem(kind.uuid, undefined),
				meta: name === undefined ? {} : { name }
			}
		}

		case "folderColorChanged": {
			const name = dirMetaName(kind.name)

			return {
				icon: "color",
				titleKey: "eventsTitleColorChanged",
				values: { name: name ?? directoryFallback },
				item: directoryItem(kind.uuid, undefined),
				meta: name === undefined ? {} : { name }
			}
		}

		case "folderShared": {
			const name = dirMetaName(kind.name)

			return {
				icon: "share",
				titleKey: "eventsTitleShared",
				values: { name: name ?? directoryFallback, email: emailLabel(kind.receiverEmail, ctx) },
				item: directoryItem(kind.uuid, kind.parent),
				meta: name === undefined ? {} : { name },
				locationVerb: "in"
			}
		}

		case "folderLinkEdited": {
			// The event names no directory: only a cached listing can.
			const name = kind.uuid === undefined ? undefined : ctx.directoryName(kind.uuid)

			return {
				icon: "link",
				titleKey: name === undefined ? "eventsTitleDirectoryLinkChanged" : "eventsTitleLinkChanged",
				values: name === undefined ? {} : { name },
				item: directoryItem(kind.uuid, undefined),
				meta: name === undefined ? {} : { name }
			}
		}

		case "itemFavorite": {
			const meta = fileMetaFields(kind.metadata)
			const directory = kind.itemType === "folder"
			const fallback = directory ? directoryFallback : kind.itemType === "file" ? fileFallback : ctx.t("eventsFallbackItem")
			const parts: KindParts = {
				icon: kind.value ? "favorite" : "unfavorite",
				titleKey: kind.value ? "eventsTitleFavorited" : "eventsTitleUnfavorited",
				values: { name: meta.name ?? fallback },
				item: directory ? directoryItem(kind.uuid, undefined) : fileItem(kind.uuid, kind.stableUuid, undefined),
				meta
			}

			if (!directory) {
				parts.fileIcon = fileIconKey(meta.name ?? "", meta.mime)
			}

			return parts
		}

		case "login":
			return { icon: "signIn", titleKey: "eventsTitleSignedIn", values: {} }

		case "failedLogin":
			return { icon: "failedSignIn", titleKey: "eventsTitleFailedSignIn", values: {} }

		case "passwordChanged":
			return { icon: "password", titleKey: "eventsTitlePasswordChanged", values: {} }

		case "twoFaEnabled":
			return { icon: "twoFactorOn", titleKey: "eventsTitleTwoFactorEnabled", values: {} }

		case "twoFaDisabled":
			return { icon: "twoFactorOff", titleKey: "eventsTitleTwoFactorDisabled", values: {} }

		case "requestAccountDeletion":
			return { icon: "accountDeletion", titleKey: "eventsTitleAccountDeletionRequested", values: {} }

		case "trashEmptied":
			return { icon: "trash", titleKey: "eventsTitleTrashEmptied", values: {} }

		case "deleteAll":
			return { icon: "delete", titleKey: "eventsTitleDeletedEverything", values: {} }

		case "deleteVersioned":
			return { icon: "delete", titleKey: "eventsTitleDeletedAllVersions", values: {} }

		case "deleteUnfinished":
			return { icon: "delete", titleKey: "eventsTitleDeletedUnfinished", values: {} }

		case "codeRedeemed":
			return { icon: "code", titleKey: "eventsTitleCodeRedeemed", values: { code: kind.code } }

		case "emailChanged":
			return { icon: "email", titleKey: "eventsTitleEmailChanged", values: { email: kind.email } }

		case "emailChangeAttempt":
			return { icon: "email", titleKey: "eventsTitleEmailChangeRequested", values: { email: kind.newEmail } }

		case "removedSharedInItems":
			return {
				icon: "unshare",
				titleKey: "eventsTitleRemovedSharedIn",
				values: { count: Number(kind.count), email: emailLabel(kind.sharerEmail, ctx) }
			}

		case "removedSharedOutItems":
			return {
				icon: "unshare",
				titleKey: "eventsTitleRemovedSharedOut",
				values: { count: Number(kind.count), email: emailLabel(kind.receiverEmail, ctx) }
			}
	}
}

// The sentence values that hold an item's own name.
export const NAME_VALUE_KEYS = ["name", "oldName", "newName"] as const satisfies readonly (keyof EventTitleValues)[]

export function isMisleadingName(name: string | undefined): boolean {
	return name !== undefined && MISLEADING_CHARACTER.test(name)
}

export function describeEvent(entry: EventEntry, ctx: EventModelContext): EventDescription {
	const ip = entry.type === "ok" ? entry.event.kind.ip : entry.raw.ip
	const userAgent = entry.type === "ok" ? entry.event.kind.userAgent : entry.raw.userAgent
	const parts: KindParts =
		entry.type === "ok"
			? kindParts(entry.event.kind, ctx)
			: entry.raw.type === undefined
				? { icon: "unknown", titleKey: "eventsTitleUnknownUntyped", values: {} }
				: { icon: "unknown", titleKey: "eventsTitleUnknown", values: { type: entry.raw.type } }
	const category = entryCategory(entry)
	const device = parseEventUserAgent(userAgent)
	const label = eventDeviceLabel(device, ctx.t)
	const location = directoryLabel(parts.item?.parent, ctx)
	const secondary: string[] = []

	if (location !== undefined) {
		// Isolated (FSI … PDI), so a right-to-left name can't reorder the rest of the line.
		secondary.push(ctx.t(parts.locationVerb === "to" ? "eventsLocationTo" : "eventsLocationIn", { name: `\u2068${location}\u2069` }))
	}

	if (parts.meta?.size !== undefined && parts.item?.type === "file") {
		secondary.push(formatBytes(parts.meta.size))
	}

	secondary.push(label)

	// An event the build can't read still shows where it came from.
	if ((category === "security" || entry.type === "unknown") && ip !== undefined && ip.length > 0) {
		secondary.push(ip)
	}

	const description: EventDescription = {
		category,
		icon: parts.icon,
		tone: kindTone(entry.type === "ok" ? entry.event.kind.type : knownKindType(entry.raw.type)),
		titleKey: parts.titleKey,
		values: parts.values,
		// Spread: an interface carries no index signature for t's options.
		title: ctx.t(parts.titleKey, { ...parts.values }),
		device,
		deviceLabel: label,
		secondary
	}

	if (parts.fileIcon !== undefined) {
		description.fileIcon = parts.fileIcon
	}

	if (parts.item !== undefined) {
		description.item = parts.item
	}

	if (parts.meta !== undefined) {
		description.meta = parts.meta
	}

	if (location !== undefined) {
		description.location = location
	}

	if (ip !== undefined && ip.length > 0) {
		description.ip = ip
	}

	if (userAgent !== undefined && userAgent.length > 0) {
		description.userAgent = userAgent
	}

	if (NAME_VALUE_KEYS.some(key => isMisleadingName(parts.values[key]))) {
		description.misleading = true
	}

	return description
}

// The raw emails an event names, for search beside their display names.
function eventEmails(entry: EventEntry): string[] {
	if (entry.type !== "ok") {
		return []
	}

	const kind = entry.event.kind

	switch (kind.type) {
		case "fileShared":
		case "folderShared":
		case "removedSharedOutItems":
			return [kind.receiverEmail]

		case "removedSharedInItems":
			return [kind.sharerEmail]

		case "emailChanged":
			return [kind.email]

		case "emailChangeAttempt":
			return [kind.email, kind.oldEmail, kind.newEmail]

		default:
			return []
	}
}

function searchTextOf(entry: EventEntry, description: EventDescription): string {
	const { values } = description
	const parts = [description.title, description.deviceLabel, ...eventEmails(entry)]

	for (const value of [values.name, values.oldName, values.newName, values.email, values.code, description.location, description.ip]) {
		if (value !== undefined) {
			parts.push(value)
		}
	}

	return parts.join("\n").toLowerCase()
}

// Lowercased: names, emails and contact names, code, location, IP, device and the sentence itself.
export function eventSearchText(entry: EventEntry, ctx: EventModelContext): string {
	return searchTextOf(entry, describeEvent(entry, ctx))
}

export interface EventDescriber {
	describe: (entry: EventEntry) => EventDescription
	searchText: (entry: EventEntry) => string
}

// describeEvent and eventSearchText memoised per event for one context: entries are rebuilt on every
// cache write, the event objects they wrap are not. Build one per context.
export function createEventDescriber(ctx: EventModelContext): EventDescriber {
	const descriptions = new WeakMap<object, EventDescription>()
	const searchTexts = new WeakMap<object, string>()

	function describe(entry: EventEntry): EventDescription {
		let description = descriptions.get(entry.event)

		if (description === undefined) {
			description = describeEvent(entry, ctx)
			descriptions.set(entry.event, description)
		}

		return description
	}

	return {
		describe,
		searchText: entry => {
			let text = searchTexts.get(entry.event)

			if (text === undefined) {
				text = searchTextOf(entry, describe(entry))
				searchTexts.set(entry.event, text)
			}

			return text
		}
	}
}

// ── Day grouping ─────────────────────────────────────────────────────────────

export type EventDayKind = "today" | "yesterday" | "earlier"

export type EventListRow =
	{ type: "day"; key: string; day: EventDayKind; dayStart: number } | { type: "event"; key: string; entry: EventEntry }

function startOfDay(ms: number): number {
	return new Date(ms).setHours(0, 0, 0, 0)
}

// The flat row list a virtualizer renders: a header before each local day's events. `entries` is newest
// first, so one comparison per entry finds the day breaks.
export function groupEventsByDay(entries: readonly EventEntry[], now: number): EventListRow[] {
	const todayStart = startOfDay(now)
	const yesterdayStart = startOfDay(todayStart - 1)
	const rows: EventListRow[] = []
	let dayStart = Number.POSITIVE_INFINITY

	for (const entry of entries) {
		const timestamp = Number(entry.timestamp)

		if (timestamp < dayStart) {
			dayStart = startOfDay(timestamp)

			const day: EventDayKind = dayStart >= todayStart ? "today" : dayStart >= yesterdayStart ? "yesterday" : "earlier"

			rows.push({ type: "day", key: `day:${String(dayStart)}`, day, dayStart })
		}

		rows.push({ type: "event", key: entry.key, entry })
	}

	return rows
}

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" })
const DAY_FORMAT_WITH_YEAR = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })

// "Today", "Yesterday", or the weekday and date (with the year once it isn't this one).
export function eventDayLabel(row: Extract<EventListRow, { type: "day" }>, t: EventModelContext["t"], now: number): string {
	if (row.day === "today") {
		return t("eventsDayToday")
	}

	if (row.day === "yesterday") {
		return t("eventsDayYesterday")
	}

	const date = new Date(row.dayStart)

	return (date.getFullYear() === new Date(now).getFullYear() ? DAY_FORMAT : DAY_FORMAT_WITH_YEAR).format(date)
}

// ── Devices and security ─────────────────────────────────────────────────────

function deviceKey(parsed: ParsedUserAgent): string | undefined {
	const client = parsed.app ?? parsed.browser

	return client === undefined && parsed.os === undefined ? undefined : `${client ?? ""}|${parsed.os ?? ""}`
}

// The keys of the entries where a browser (or app) and OS combination appears first in the loaded
// history, scanning oldest first. Entries whose user agent says nothing are skipped.
export function detectNewDevices(entries: readonly EventEntry[]): Set<string> {
	const seen = new Set<string>()
	const firsts = new Set<string>()

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]

		if (entry === undefined) {
			continue
		}

		const key = deviceKey(parseEventUserAgent(entry.type === "ok" ? entry.event.kind.userAgent : entry.raw.userAgent))

		if (key !== undefined && !seen.has(key)) {
			seen.add(key)
			firsts.add(entry.key)
		}
	}

	return firsts
}

export interface EventSecuritySummary {
	lastLogin?: OkEntry
	failedLast7d: number
	lastPasswordChange?: OkEntry
	last2faChange?: { entry: OkEntry; enabled: boolean }
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

// Over the loaded entries (newest first). A missing change means "not in what is loaded": only once the
// whole 30-day window is loaded does it mean "not in the last 30 days".
export function securitySummary(entries: readonly EventEntry[], now: number): EventSecuritySummary {
	const summary: EventSecuritySummary = { failedLast7d: 0 }
	const failedSince = BigInt(now - SEVEN_DAYS_MS)

	for (const entry of entries) {
		if (entry.type !== "ok") {
			continue
		}

		switch (entry.event.kind.type) {
			case "login":
				summary.lastLogin ??= entry
				break

			case "failedLogin":
				if (entry.timestamp >= failedSince) {
					summary.failedLast7d++
				}

				break

			case "passwordChanged":
				summary.lastPasswordChange ??= entry
				break

			case "twoFaEnabled":
			case "twoFaDisabled":
				summary.last2faChange ??= { entry, enabled: entry.event.kind.type === "twoFaEnabled" }
				break

			default:
				break
		}
	}

	return summary
}

// ── Detail fields ────────────────────────────────────────────────────────────

export interface EventDetailField {
	labelKey: EventsKey
	value: string
	// No readable structure to truncate from one end (an IP, a user agent, an id).
	opaque?: boolean
	// A directory color's swatch.
	color?: string
	// A muted aside after the value (a custom color's hex).
	hint?: string
}

export interface EventDetailSections {
	item: EventDetailField[]
	device: EventDetailField[]
	details: EventDetailField[]
}

const COLOR_LABEL_KEYS = {
	default: "driveColorDefault",
	blue: "driveColorBlue",
	green: "driveColorGreen",
	purple: "driveColorPurple",
	red: "driveColorRed",
	gray: "driveColorGray"
} as const satisfies Record<NamedDirColor, DriveKey>

// The drive's own name for a directory color; a custom one keeps its hex beside the name. A color the
// server didn't send, sent as null or sent malformed paints as the default, and is named so.
function colorField(labelKey: EventsKey, color: DirColor | null | undefined, t: EventModelContext["t"]): EventDetailField {
	const hex = dirColorHex(color)

	if (color !== null && color !== undefined && !isNamedDirColor(color) && isValidHexColor(color)) {
		return { labelKey, value: t("drive:driveColorCustomLabel"), hint: color, color: hex }
	}

	const named = color !== null && color !== undefined && isNamedDirColor(color) ? color : "default"

	return { labelKey, value: t(`drive:${COLOR_LABEL_KEYS[named]}`), color: hex }
}

function contactValue(email: string, ctx: EventModelContext): string {
	const contact = ctx.contact(email)

	return contact === undefined || contact.name === email ? email : `${contact.name} (${email})`
}

function itemFields(entry: OkEntry, description: EventDescription, ctx: EventModelContext): EventDetailField[] {
	const { t } = ctx
	const kind = entry.event.kind
	const fields: EventDetailField[] = []
	const meta = description.meta
	const push = (labelKey: EventsKey, value: string | undefined, opaque?: boolean) => {
		if (value !== undefined && value.length > 0) {
			fields.push(opaque === true ? { labelKey, value, opaque } : { labelKey, value })
		}
	}

	if (
		kind.type === "fileRenamed" ||
		kind.type === "fileMetadataChanged" ||
		kind.type === "folderRenamed" ||
		kind.type === "folderMetadataChanged"
	) {
		const oldName =
			kind.type === "fileRenamed" || kind.type === "fileMetadataChanged"
				? fileMetaFields(kind.oldMetadata).name
				: dirMetaName(kind.oldName)

		push("eventsFieldPreviousName", oldName ?? t("eventsValueEncrypted"))
		push("eventsFieldNewName", meta?.name ?? t("eventsValueEncrypted"))
	} else if (description.item !== undefined && description.values.name !== undefined) {
		push("eventsFieldName", meta?.name ?? t("eventsValueEncrypted"))
	}

	if (description.item?.type === "file") {
		push("eventsFieldType", meta?.mime)
		push("eventsFieldSize", meta?.size === undefined ? undefined : formatBytes(meta.size))
		push("eventsFieldModified", meta?.modified === undefined ? undefined : new Date(meta.modified).toLocaleString())
	}

	push("eventsFieldLocation", description.location)

	switch (kind.type) {
		case "folderColorChanged":
			fields.push(colorField("eventsFieldPreviousColor", kind.oldColor, t))
			fields.push(colorField("eventsFieldColor", kind.color, t))
			break

		case "itemFavorite":
			push("eventsFieldFavorite", kind.value ? t("eventsValueFavoriteAdded") : t("eventsValueFavoriteRemoved"))
			break

		case "fileShared":
		case "folderShared":
		case "removedSharedOutItems":
			push("eventsFieldSharedWith", contactValue(kind.receiverEmail, ctx))
			break

		case "removedSharedInItems":
			push("eventsFieldSharedBy", contactValue(kind.sharerEmail, ctx))
			break

		case "codeRedeemed":
			push("eventsFieldCode", kind.code)
			break

		case "emailChanged":
			push("eventsFieldEmail", kind.email)
			break

		case "emailChangeAttempt":
			push("eventsFieldEmail", kind.email)
			push("eventsFieldPreviousEmail", kind.oldEmail)
			push("eventsFieldNewEmail", kind.newEmail)
			break

		default:
			break
	}

	if (kind.type === "removedSharedInItems" || kind.type === "removedSharedOutItems") {
		push("eventsFieldItems", kind.count.toString())
	}

	return fields
}

// The detail dialog's sections. Empty sections are left for the caller to hide.
export function eventDetailSections(entry: EventEntry, description: EventDescription, ctx: EventModelContext): EventDetailSections {
	const { device } = description
	const deviceFields: EventDetailField[] = []
	const details: EventDetailField[] = []
	const withVersion = (name: string, version: string | undefined) => (version === undefined ? name : `${name} ${version}`)

	if (device.app !== undefined) {
		deviceFields.push({ labelKey: "eventsFieldApp", value: device.app })
	}

	if (device.browser !== undefined) {
		deviceFields.push({ labelKey: "eventsFieldBrowser", value: withVersion(device.browser, device.browserVersion) })
	}

	if (device.os !== undefined) {
		deviceFields.push({ labelKey: "eventsFieldOperatingSystem", value: withVersion(device.os, device.osVersion) })
	}

	if (description.ip !== undefined) {
		deviceFields.push({ labelKey: "eventsFieldIpAddress", value: description.ip, opaque: true })
	}

	if (description.userAgent !== undefined) {
		deviceFields.push({ labelKey: "eventsFieldUserAgent", value: description.userAgent, opaque: true })
	}

	if (entry.type === "ok") {
		details.push({ labelKey: "eventsFieldEventId", value: entry.event.id.toString(), opaque: true })
	} else {
		if (entry.raw.type !== undefined) {
			details.push({ labelKey: "eventsFieldEventType", value: entry.raw.type })
		}

		if (entry.raw.id !== undefined) {
			details.push({ labelKey: "eventsFieldEventId", value: entry.raw.id.toString(), opaque: true })
		}
	}

	if (description.item?.uuid !== undefined) {
		details.push({ labelKey: "eventsFieldItemId", value: description.item.uuid, opaque: true })
	}

	const kind = entry.type === "ok" ? entry.event.kind : undefined

	if ((kind?.type === "fileLinkEdited" || kind?.type === "folderLinkEdited") && kind.linkUuid !== undefined) {
		details.push({ labelKey: "eventsFieldLinkId", value: kind.linkUuid, opaque: true })
	}

	return { item: entry.type === "ok" ? itemFields(entry, description, ctx) : [], device: deviceFields, details }
}
