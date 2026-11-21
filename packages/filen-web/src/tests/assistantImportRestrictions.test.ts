import { describe, expect, it } from "vitest"
import { fileURLToPath } from "node:url"
import { ESLint, type Linter } from "eslint"
import tseslint from "typescript-eslint"

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url))
const IMPORT_RULES = ["no-restricted-imports", "@typescript-eslint/no-restricted-imports", "no-restricted-syntax"]

// The rules as the real config resolves them for a file, run on their own over an untyped TS
// fixture: the typed config would need the fixture inside the TS project.
async function lintImports(file: string, source: string): Promise<string[]> {
	const config = (await new ESLint({ cwd: PACKAGE_ROOT }).calculateConfigForFile(file)) as Linter.Config
	const rules: Linter.RulesRecord = {}

	for (const name of IMPORT_RULES) {
		const rule = config.rules?.[name]

		if (rule !== undefined) {
			rules[name] = rule
		}
	}

	const linter = new ESLint({
		cwd: PACKAGE_ROOT,
		overrideConfigFile: true,
		overrideConfig: [
			{
				files: ["**/*.ts"],
				languageOptions: { parser: tseslint.parser },
				plugins: { "@typescript-eslint": tseslint.plugin },
				rules
			}
		] as Linter.Config[]
	})
	const [result] = await linter.lintText(source, { filePath: "fixture.ts" })

	return (result?.messages ?? []).map(message => message.message)
}

const FORBIDDEN = [
	'import { deleteItemsPermanently, emptyTrash, trashItems } from "@/features/drive/lib/actions"',
	'import { createLink, updateLink } from "@/features/drive/lib/actions"',
	'import { shareItems, unshareItems } from "@/features/drive/lib/share/actions"',
	'import { deleteNote, leaveNote } from "@/features/notes/lib/actions"',
	'import { addNoteParticipants, setNoteParticipantPermission } from "@/features/notes/lib/participants"',
	'import { deleteChat } from "@/features/chats/lib/actions"',
	'import { enqueueChatMessage, sync } from "@/features/chats/lib/sync"',
	'import { deleteMessage, editMessage, disableMessageEmbed } from "@/features/chats/lib/messageActions"',
	'import { deleteDraft } from "@/features/chats/lib/drafts"',
	'import { addChatParticipants } from "@/features/chats/lib/participants"',
	'import { retryInflightMessage, purgeChatInflightState } from "@/features/chats/lib/inflight"',
	'import { startChatOutbox } from "@/features/chats/lib/outboxCoordinator"',
	'import { trustDomain } from "@/features/chats/lib/trustedDomains"',
	'import { uploadAttachment } from "@/features/chats/lib/attachments"',
	'import { enqueueInflightMessage, useChatsInflightStore } from "@/features/chats/store/useChatsInflight"',
	'import { deletePlaylistAction } from "@/features/audio/lib/playlists"',
	'import { blockContact, sendContactRequest, acceptRequest, messageContact } from "@/features/contacts/lib/actions"',
	'import { requestJobCancel } from "@/features/transfers/lib/control"',
	'import { cancelTransfers, setTransfersPaused } from "@/features/transfers/lib/control"',
	'import { restoreItems, restoreVersion } from "@/features/drive/lib/actions"',
	'import { restoreNote } from "@/features/notes/lib/actions"',
	'import { restoreNotes } from "@/features/notes/lib/bulk"',
	'import { restoreNoteFromHistory } from "@/features/notes/lib/history"',
	'import { clearSession, persistSession, resumeSession, broadcastAuth } from "@/lib/sdk/session"',
	'import { runLogout } from "@/lib/logout"',
	'import { performLogout } from "@/features/shell/lib/performLogout"',
	'import { ChangePassword } from "@/features/settings/components/security/changePassword"',
	'import { setTheme } from "@/features/settings/lib/theme"',
	'import { pendingSdkCalls } from "@/e2e-hooks/sdkCalls"',
	'import { desktopBridge } from "@/lib/desktop"',
	'import { syncApi, openAddPair, closeAddPair } from "@/features/sync/lib/syncStore"',
	'import { mountsApi, confirmMountsSignOut } from "@/features/mounts/lib/mountsStore"'
]

describe("assistant import restrictions", () => {
	it.each(["src/features/assistant/runtime/loop.ts", "src/features/assistant/tools/drive.ts", "src/workers/assistant.worker.ts"])(
		"keeps deleting, restoring, sending, queueing, sharing, settings, transfer control, the session, logout and the desktop bridge out of reach in %s",
		async file => {
			const messages = await lintImports(file, FORBIDDEN.join("\n"))

			// One per banned name, or per statement for a module banned whole; trashItems passes.
			expect(messages).toHaveLength(42)
			expect(messages.every(message => message.includes("irreversible or security-critical"))).toBe(true)

			for (const line of FORBIDDEN) {
				await expect(lintImports(file, line)).resolves.not.toEqual([])
			}
		}
	)

	it("still allows the trash, which the user can undo, and reading a draft", async () => {
		await expect(
			lintImports(
				"src/features/assistant/tools/drive.ts",
				'import { trashItems } from "@/features/drive/lib/actions"\nimport { loadDraft } from "@/features/chats/lib/drafts"'
			)
		).resolves.toEqual([])
	})

	it.each(["src/features/assistant/runtime/loop.ts", "src/features/assistant/store/x.ts", "src/features/assistant/tools/drive.ts"])(
		"keeps %s off the raw SDK, allowing only its types",
		async file => {
			const messages = await lintImports(
				file,
				[
					'import { sdkApi } from "@/lib/sdk/client"',
					'import { api } from "@/workers/sdk.worker"',
					'import { FilenSdkError } from "@filen/sdk-rs"'
				].join("\n")
			)

			expect(messages).toHaveLength(3)
			expect(messages.every(message => message.includes("never the raw SDK"))).toBe(true)
			await expect(
				lintImports(
					file,
					'import type { Note } from "@filen/sdk-rs"\nimport { type Chat } from "@filen/sdk-rs"\nimport type { ArchiveNameInfo } from "@/workers/sdk.worker"'
				)
			).resolves.toEqual([])
		}
	)

	it.each(["src/features/assistant/tools/routes.ts", "src/workers/assistant.worker.ts"])(
		"keeps the desktop bridge's global out of reach in %s, allowing only the value-free checks and the held stores",
		async file => {
			const globals = [
				"void window.desktop",
				'void window["desktop"]',
				"void globalThis.desktop?.session.get()",
				"void self.desktop",
				"const { desktop } = window"
			]

			for (const line of globals) {
				const messages = await lintImports(file, line)

				expect(messages, line).toHaveLength(1)
				expect(messages[0], line).toContain("The desktop bridge is out of the assistant's reach.")
			}

			await expect(
				lintImports(
					file,
					[
						'import { isDesktopApp, desktopPlatform } from "@/lib/desktop"',
						'import { useSyncStore } from "@/features/sync/lib/syncStore"',
						'import { useMountsStore } from "@/features/mounts/lib/mountsStore"',
						"void window.location"
					].join("\n")
				)
			).resolves.toEqual([])
		}
	)

	// The runtime runs the model on the desktop app's native engine through the bridge's assistant calls alone (model
	// files and AssistantModel requests); the rest of the bridge stays out of its reach.
	it("lets the runtime reach the desktop app's native engine, and nothing else of the bridge", async () => {
		const file = "src/features/assistant/runtime/nativeEngine.ts"

		await expect(lintImports(file, 'import { desktopAssistant } from "@/lib/desktop"')).resolves.toEqual([])

		const bridge = await lintImports(file, 'import { desktopAssistant, desktopBridge } from "@/lib/desktop"')

		expect(bridge).toHaveLength(1)
		expect(bridge[0]).toContain("desktopBridge")
		await expect(lintImports(file, "void window.desktop?.assistant")).resolves.toHaveLength(1)
	})

	it("refuses a dynamic import, which the import rules cannot see", async () => {
		await expect(lintImports("src/features/assistant/loop/x.ts", 'void import("@/lib/sdk/client")')).resolves.toEqual([
			"A dynamic import would slip past the assistant's import restrictions."
		])
	})

	// The assistant's own no-restricted-syntax replaces the app-wide one, so it must carry the lazy-loading bans
	// too: an eager glob would bundle a forbidden module with no import declaration for the import rules to see.
	it("refuses import.meta.glob and lazy loading, which the import rules cannot see either", async () => {
		await expect(
			lintImports(
				"src/features/assistant/tools/x.ts",
				'const actions = import.meta.glob("@/features/drive/lib/actions.ts", { eager: true })\nconst Panel = lazy(() => Promise.resolve({ default: () => null }))'
			)
		).resolves.toEqual([
			"import.meta.glob defaults to lazy imports; import statically.",
			"No lazy-loaded components; import statically."
		])
	})

	it("keeps relative imports out everywhere and leaves the rest of the app alone", async () => {
		await expect(lintImports("src/features/assistant/tools/drive.ts", 'import "./x"')).resolves.toHaveLength(1)
		await expect(
			lintImports(
				"src/features/drive/lib/actions.ts",
				'import { emptyTrash } from "@/features/drive/lib/actions"\nimport { sdkApi } from "@/lib/sdk/client"\nvoid import("@/lib/sdk/client")'
			)
		).resolves.toEqual(["No dynamic imports in app code; import statically."])
	})
})
