import type { DirPublicLinkRW, FilePublicLink, PasswordState, PublicLinkExpiration } from "@filen/sdk-rs"
import { buildPublicLinkUrl as buildPublicLinkUrlString } from "@/features/publicLinks/lib/format.logic"
import { asDirectoryOrFile, type DriveItem } from "@/features/drive/lib/item"
import { formatItemSize } from "@/features/drive/lib/format"
import type { DriveItemLinkStatus } from "@/features/drive/queries/drive"
import type { DriveKey } from "@/lib/i18n"

// Normalized shape the dialog's form reads from — collapses the dir/file field-name asymmetry
// (`enableDownload` vs `downloadable`) into one internal name.
export interface LinkFormState {
	downloadEnabled: boolean
	expiration: PublicLinkExpiration
	passwordSet: boolean
}

// A user-driven password edit. Omitted entirely (the `password` key absent from LinkFormEdits) means
// "untouched" — the caller resends the existing PasswordState verbatim, because a `hashed` value
// can't be reconstructed from anything the client holds. "new" is a plaintext the user just typed;
// "cleared" is an explicit removal.
export type PasswordEdit = { kind: "new"; plaintext: string } | { kind: "cleared" }

export interface LinkFormEdits {
	downloadEnabled?: boolean
	expiration?: PublicLinkExpiration
	password?: PasswordEdit
}

// DirPublicLinkRW's download flag is `enableDownload`; FilePublicLink's is `downloadable` — mutually
// exclusive field names (never both present on the same object), so this is an exact structural
// probe, not a heuristic — mirrors features/drive/lib/item.ts's identical isFile ("chunks" in raw) check.
function isDirLink(status: DirPublicLinkRW | FilePublicLink): status is DirPublicLinkRW {
	return "enableDownload" in status
}

export function readLinkForm(status: DirPublicLinkRW | FilePublicLink): LinkFormState {
	return {
		downloadEnabled: isDirLink(status) ? status.enableDownload : status.downloadable,
		expiration: status.expiration,
		passwordSet: status.password.type !== "none"
	}
}

function resolvePassword(current: PasswordState, edit: PasswordEdit | undefined): PasswordState {
	if (edit === undefined) {
		return current
	}

	if (edit.kind === "cleared") {
		return { type: "none" }
	}

	// PasswordState's "known" arm is adjacently tagged (`{ type: "known"; data: string }`) — the
	// plaintext the user typed goes in `data`; the SDK hashes+salts it server-side.
	return { type: "known", data: edit.plaintext }
}

// Maps the normalized form edits back onto the right field name per item type and resolves the
// password per the untouched/new/cleared rule above. Every other field (linkUuid/salt/linkKey/
// linkKeyVersion) survives from `current` unchanged via the spread. Takes and returns the tagged
// {type, status} union (not a bare DirPublicLinkRW | FilePublicLink with a separate item-type
// parameter) so the dir/file branch is a real discriminated-union narrow — TypeScript can't
// correlate two independently-typed parameters, and this project's lint forbids the `as` cast that
// would otherwise be needed. Mirrors filen-mobile's own updatePublicLink, which takes the identical
// tagged shape for the identical reason.
export function buildLinkUpdate(current: DriveItemLinkStatus, edits: LinkFormEdits): DriveItemLinkStatus {
	const password = resolvePassword(current.status.password, edits.password)
	const expiration = edits.expiration ?? current.status.expiration

	if (current.type === "directory") {
		return {
			type: "directory",
			status: {
				...current.status,
				password,
				expiration,
				enableDownload: edits.downloadEnabled ?? current.status.enableDownload
			}
		}
	}

	return {
		type: "file",
		status: {
			...current.status,
			password,
			expiration,
			downloadable: edits.downloadEnabled ?? current.status.downloadable
		}
	}
}

// A file link's key is the ITEM's own decrypted metadata key (FilePublicLink itself carries no key
// field); a directory link's key is the LINK's own linkKey (absent until the link finishes
// provisioning). Returns null rather than throwing when the needed key isn't available — the caller
// degrades the URL field/copy action, not the whole panel. `item.type`/`status.type` are checked
// together (not `item.type === status.type` as a single boolean) so each independently narrows its own
// variable — a mismatch between the two falls through to the null case rather than reading a field
// that doesn't exist on the other arm. The URL shape itself (NEW path-based format, key hex-encoded in
// the fragment) is owned by features/publicLinks/lib/format.logic.ts — the same module the /f/ /d/
// route and the chat recognizer parse with, so a built link always round-trips.
export function buildPublicLinkUrl(item: DriveItem, status: DriveItemLinkStatus): string | null {
	if (item.type === "file" && status.type === "file") {
		const key = item.data.decryptedMeta?.key

		if (key === undefined) {
			return null
		}

		return buildPublicLinkUrlString("file", status.status.linkUuid, key)
	}

	if (item.type === "directory" && status.type === "directory") {
		const linkKey = status.status.linkKey

		if (linkKey === undefined) {
			return null
		}

		return buildPublicLinkUrlString("directory", status.status.linkUuid, linkKey)
	}

	return null
}

// Public links require a subscription (mobile parity — filen-mobile/src/features/publicLink/screen.tsx's
// own `userIsSubbed` gate) — a tri-state rather than a plain boolean so "the account query hasn't
// resolved yet" is a distinct, explicit state from "resolved and not premium": the two render
// completely differently (a loading skeleton vs. the subscription empty-state), and collapsing them
// would flash the gate at every account-query cold start. `isPremium` is `undefined` for BOTH the
// pending and the error case (an error never overwrites previously-cached data, and there is none on a
// cold start) — the caller passes `accountQuery.data?.isPremium` directly, never a bespoke status check.
export type PremiumGateState = "loading" | "gated" | "allowed"

export function resolvePremiumGateState(isPremium: boolean | undefined): PremiumGateState {
	if (isPremium === undefined) {
		return "loading"
	}

	return isPremium ? "allowed" : "gated"
}

// The dialog's item-hero header — name, type label, and (files only) a size line. A directory's true
// size needs the same remote getItemInfo call infoDialog.tsx pays for its own hero; this panel skips
// that fetch (nothing else here needs it) and just omits the size line for a directory, same degrade
// infoDialog uses while its own size row hasn't resolved yet.
export interface LinkHeroInfo {
	name: string
	typeLabelKey: DriveKey
	sizeLabel: string | null
}

export function resolveLinkHeroInfo(item: DriveItem): LinkHeroInfo {
	const isDirectory = asDirectoryOrFile(item).type === "directory"

	return {
		name: item.data.decryptedMeta?.name ?? item.data.uuid,
		typeLabelKey: isDirectory ? "driveItemTypeDirectory" : "driveItemTypeFile",
		sizeLabel: isDirectory ? null : formatItemSize(item)
	}
}
