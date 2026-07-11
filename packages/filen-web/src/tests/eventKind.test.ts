import { describe, expect, it } from "vitest"
import { EVENT_KIND_META, eventKindMeta } from "@/features/settings/lib/eventKind"

// Every real wasm UserEventKind["type"] member, copied straight from sdk-rs.d.ts's union (verified
// against the installed package — see the module's own header comment for the source line).
const WASM_KIND_TYPES = [
	"fileUploaded",
	"fileVersioned",
	"fileRestored",
	"versionedFileRestored",
	"fileMoved",
	"fileRenamed",
	"fileMetadataChanged",
	"fileTrash",
	"fileRm",
	"fileShared",
	"fileLinkEdited",
	"deleteFilePermanently",
	"folderTrash",
	"folderShared",
	"folderMoved",
	"folderRenamed",
	"folderMetadataChanged",
	"subFolderCreated",
	"baseFolderCreated",
	"folderRestored",
	"folderColorChanged",
	"deleteFolderPermanently",
	"login",
	"failedLogin",
	"passwordChanged",
	"twoFaEnabled",
	"twoFaDisabled",
	"requestAccountDeletion",
	"trashEmptied",
	"deleteAll",
	"deleteVersioned",
	"deleteUnfinished",
	"codeRedeemed",
	"emailChanged",
	"emailChangeAttempt",
	"removedSharedInItems",
	"removedSharedOutItems",
	"folderLinkEdited",
	"itemFavorite"
]

describe("EVENT_KIND_META", () => {
	it("has an entry for every real wasm UserEventKind type", () => {
		for (const type of WASM_KIND_TYPES) {
			expect(EVENT_KIND_META).toHaveProperty(type)
		}
	})

	it("maps BOTH the wasm spelling and mobile's legacy leading-digit spelling to the same 2FA labels — the WASM RENAME GOTCHA", () => {
		expect(eventKindMeta("twoFaEnabled").labelKey).toBe("settingsEventTwoFaEnabled")
		expect(eventKindMeta("2faEnabled").labelKey).toBe("settingsEventTwoFaEnabled")
		expect(eventKindMeta("twoFaDisabled").labelKey).toBe("settingsEventTwoFaDisabled")
		expect(eventKindMeta("2faDisabled").labelKey).toBe("settingsEventTwoFaDisabled")
	})
})

describe("eventKindMeta", () => {
	it("resolves every known kind to a distinct, non-fallback label key", () => {
		for (const type of WASM_KIND_TYPES) {
			expect(eventKindMeta(type).labelKey).not.toBe("settingsEventUnknown")
		}
	})

	it("never crashes on a server event type this build doesn't know about yet — falls back to the generic label", () => {
		expect(eventKindMeta("someBrandNewServerEventType").labelKey).toBe("settingsEventUnknown")
	})
})
