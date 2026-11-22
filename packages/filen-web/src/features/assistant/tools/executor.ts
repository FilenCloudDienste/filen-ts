import {
	contextName,
	isAssistantWebTool,
	isConsequentialTool,
	openDocumentContext,
	sanitizeUntrustedText,
	screenOpened,
	toolInputJsonSchema,
	type AssistantHistoryTurn,
	type AssistantSignal,
	type AssistantTool,
	type AssistantToolFailure,
	type AssistantToolName,
	type AssistantToolProgress,
	type AssistantWebToolName
} from "@filen/shared/assistant"
import type { Note } from "@filen/sdk-rs"
import type { RegisteredRouter } from "@tanstack/react-router"
import { log } from "@/lib/log"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { findCachedListingItem } from "@/features/drive/queries/drive"
import { isDirectoryItem, type DriveItem } from "@/features/drive/lib/item"
import {
	DESTINATION_ARGS,
	type AssistantHandleRef,
	type AssistantPreviewTarget,
	type AssistantTurnContextOptions,
	type ToolExecutor
} from "@/features/assistant/runtime/executor"
import { AssistantHandleRegistry, ROOT_HANDLE, type AssistantEntityKind } from "@/features/assistant/tools/handles"
import { AssistantToolError, sanitizeStrings, unlessStopped } from "@/features/assistant/tools/format"
import {
	chatName,
	chatRecipients,
	driveName,
	entityName,
	freshEntity,
	noteTitle,
	resolveDrivePath,
	resolveHandle,
	type ToolAdapter,
	type ToolScope
} from "@/features/assistant/tools/entities"
import { readAssistantContext } from "@/features/assistant/tools/context"
import { readDocumentTool } from "@/features/assistant/tools/documents"
import { getActiveDocument } from "@/lib/activeDocument"
import { assistantRouter } from "@/features/assistant/tools/navigation"
import { navigateToRoute, navigateToSyncPairIssues, UNAVAILABLE_ROUTES, type AssistantRouteName } from "@/features/assistant/tools/routes"
import { useSyncStore } from "@/features/sync/lib/syncStore"
import {
	getItemInfoTool,
	isTrashed,
	listDirectoryTool,
	readTextFileTool,
	revealItemTool,
	searchItemsTool
} from "@/features/assistant/tools/drive"
import { getSharingTool, listSectionTool } from "@/features/assistant/tools/sharing"
import { getTransfersTool } from "@/features/assistant/tools/transfers"
import { listNotesTool, openNoteTool, readNoteTool, searchNoteTextTool } from "@/features/assistant/tools/notes"
import { getStorageTool, listPhotosTool, recentItemsTool } from "@/features/assistant/tools/insights"
import { userCalendar, type UserCalendar } from "@/features/assistant/tools/dates"
import {
	draftChatMessageTool,
	draftChatProblem,
	draftText,
	findContactsTool,
	listChatsTool,
	openChatTool,
	readChatTool
} from "@/features/assistant/tools/chats"
import { audioControlTool, listPlaylistsTool, openPlaylistTool, playTool } from "@/features/assistant/tools/audio"
import {
	addTracksToPlaylistTool,
	copyItemsTool,
	createDirectoryTool,
	createNoteTool,
	destinationPath,
	moveItemsTool,
	renameItemTool,
	restoreItemsTool,
	setFavoriteTool,
	setNoteFlagsTool,
	trashItemsTool,
	WRITE_ARGS,
	WRITE_PRECHECKS
} from "@/features/assistant/tools/writes"
import {
	BATCH_PRECHECKS,
	BATCH_WRITE_ARGS,
	batchPreview,
	clearBatchPlan,
	isBatchTool,
	organizeByDateTool,
	renameByPatternTool
} from "@/features/assistant/tools/batch"

// Which items each handle argument may name.
const HANDLE_KINDS: Partial<Record<AssistantToolName, Record<string, readonly AssistantEntityKind[]>>> = {
	list_directory: { handle: ["root", "drive"] },
	get_item_info: { handle: ["root", "drive"] },
	get_sharing: { handle: ["root", "drive"] },
	read_text_file: { handle: ["drive"] },
	reveal_item: { handle: ["root", "drive"] },
	set_favorite: { handles: ["drive"] },
	create_directory: { parent: ["root", "drive"] },
	rename_item: { handle: ["drive"] },
	move_items: { handles: ["drive"], destination: ["root", "drive"] },
	copy_items: { handles: ["drive"], destination: ["root", "drive"] },
	trash_items: { handles: ["drive", "note"] },
	read_note: { handle: ["note"] },
	open_note: { handle: ["note"] },
	set_note_flags: { handle: ["note"] },
	read_chat: { handle: ["chat"] },
	open_chat: { handle: ["chat"] },
	draft_chat_message: { chat: ["chat"] },
	open_playlist: { handle: ["playlist"] },
	play: { handle: ["drive", "playlist", "track"] },
	add_tracks_to_playlist: { playlist: ["playlist"], handles: ["drive", "track"] },
	read_document: { handle: ["drive"] },
	rename_by_pattern: { scope: ["root", "drive"], handles: ["drive"] },
	organize_by_date: { scope: ["root", "drive"] },
	restore_items: { handles: ["drive", "note"] },
	open_route: { pair: ["syncPair"] }
}

// A path the model is told to list a directory by is copied back whole, so it is never shortened: past this it
// is not offered at all.
const CONTEXT_PATH_MAX_CHARS = 512

// A path to list a directory by: whole, on one line, quoted; null when too long to offer.
function contextPath(path: string): string | null {
	const flat = sanitizeUntrustedText(path, [], { keepJoiners: true }).replace(/\s+/g, " ").trim()

	return Array.from(flat).length > CONTEXT_PATH_MAX_CHARS ? null : JSON.stringify(flat)
}

// A drive item of the screen as a handle: on Shared with me, with the uuid chain it lists by.
function shownDrive(scope: ToolScope, item: DriveItem, { shared, path }: { shared?: readonly string[]; path?: string }): string {
	return scope.show(
		{ kind: "drive", item, ...(shared === undefined ? {} : { shared }), ...(path === undefined ? {} : { path }) },
		driveName(item)
	)
}

// The document open in a preview (or the note editor), as the context line names it. A note already open on the
// notes screen is named there.
function openDocumentPart(scope: ToolScope, openNote: Note | undefined): string | null {
	const open = getActiveDocument()

	if (open === null) {
		return null
	}

	if ("note" in open.item) {
		if (openNote?.uuid === open.item.note.uuid) {
			return null
		}

		const note = open.item.note

		return openDocumentContext({
			name: noteTitle(note),
			handle: scope.show({ kind: "note", note }, noteTitle(note)),
			kind: "text",
			position: open.position,
			selectionChars: open.selection?.chars ?? null
		})
	}

	return openDocumentContext({
		name: driveName(open.item),
		handle: shownDrive(scope, open.item, {}),
		kind: open.kind === "note" ? "text" : open.kind,
		position: open.position,
		selectionChars: open.selection?.chars ?? null
	})
}

function describeContext(scope: ToolScope, { withoutDocument = false }: AssistantTurnContextOptions = {}): string {
	const { screen, directory, selection, note, chat, playing } = readAssistantContext()
	const parts = [`screen: ${screen}`]
	const sharedIn = directory?.variant === "sharedIn" ? directory.chain : null

	if (directory !== null) {
		if (directory.uuid === null) {
			parts.push(`current directory: / (handle ${ROOT_HANDLE})`)
		} else if (directory.item !== undefined) {
			const handle = shownDrive(scope, directory.item, {
				...(sharedIn === null ? {} : { shared: sharedIn }),
				...(directory.path === undefined ? {} : { path: directory.path })
			})

			parts.push(`current directory: ${contextName(directory.path ?? driveName(directory.item))} (handle ${handle})`)
		} else {
			// Opened by a link or a reveal, so its own row is not cached: the model can still list a My Drive one by
			// path. Without one it must not assume the root.
			const path = directory.variant === "drive" && directory.path !== undefined ? contextPath(directory.path) : null

			parts.push(
				path !== null
					? `current directory: ${path} (no handle; list it by this path)`
					: `current directory: ${directory.name === undefined ? "a directory whose name is not loaded" : contextName(directory.name)} (no handle; not the root)`
			)
		}
	}

	if (selection.length > 0) {
		parts.push(
			`selected: ${selection
				.slice(0, 10)
				.map(item => {
					// On Shared with me a selected directory lists through the chain down to it; a share's root is its own.
					const shared = screen === "shared_with_me" && isDirectoryItem(item) ? [...(sharedIn ?? []), item.data.uuid] : undefined
					const handle = shownDrive(scope, item, shared === undefined ? {} : { shared })

					return `${contextName(driveName(item))} (handle ${handle})`
				})
				.join(", ")}${selection.length > 10 ? ` and ${String(selection.length - 10)} more` : ""}`
		)
	} else if (directory !== null) {
		parts.push("nothing selected")
	}

	if (note !== undefined) {
		parts.push(`open note: ${contextName(noteTitle(note))} (handle ${scope.show({ kind: "note", note }, noteTitle(note))})`)
	}

	if (chat !== undefined) {
		parts.push(`open chat: ${contextName(chatName(chat))} (handle ${scope.show({ kind: "chat", chat }, chatName(chat))})`)
	}

	const document = withoutDocument ? null : openDocumentPart(scope, note)

	if (document !== null) {
		parts.push(document)
	}

	if (playing === null) {
		parts.push("nothing playing")
	} else {
		const item = findCachedListingItem(playing.track.uuid)
		const handle =
			item === undefined
				? scope.show({ kind: "track", track: playing.track }, playing.track.name)
				: scope.show({ kind: "drive", item }, driveName(item))

		parts.push(`${playing.status === "paused" ? "paused" : "playing"}: ${contextName(playing.track.name)} (handle ${handle})`)
	}

	return parts.join("; ")
}

function routeUnavailable(route: string): AssistantToolError {
	return new AssistantToolError(`"${route}" is not available in this app`)
}

// A sync pair handle opens that pair's Issues tab, whatever section the call names: the pair is the more specific.
async function openSyncPair(router: RegisteredRouter, pairId: string, scope: ToolScope): Promise<Record<string, unknown>> {
	if (UNAVAILABLE_ROUTES.has("sync")) {
		throw routeUnavailable("sync")
	}

	if (useSyncStore.getState().overview?.pairs.some(pair => pair.id === pairId) !== true) {
		throw new AssistantToolError("That sync pair no longer exists")
	}

	await navigateToSyncPairIssues(router, pairId, scope.signal)

	return { ...screenOpened("sync"), tab: "issues" }
}

const openRouteTool: ToolAdapter = async (input, scope) => {
	const router = assistantRouter()
	const route = input["route"] as AssistantRouteName
	const pair = typeof input["pair"] === "string" ? scope.registry.get(input["pair"])?.entity : undefined

	if (router === null) {
		throw new AssistantToolError("The app cannot navigate right now")
	}

	if (pair?.kind === "syncPair") {
		return { value: await openSyncPair(router, pair.pairId, scope) }
	}

	if (!(await navigateToRoute(router, route, scope.signal))) {
		throw routeUnavailable(route)
	}

	return { value: screenOpened(route) }
}

// Exactly the tools @filen/shared lists as the web app's (ASSISTANT_WEB_TOOLS, which the eval measures). Any
// other is not offered: the loop tells the model it is not available in this app.
const ADAPTERS: Record<AssistantWebToolName, ToolAdapter> = {
	get_context: (_input, scope) =>
		Promise.resolve({ value: { context: describeContext(scope, { withoutDocument: scope.withoutDocument === true }) } }),
	search_items: searchItemsTool,
	list_directory: listDirectoryTool,
	get_item_info: getItemInfoTool,
	recent_items: recentItemsTool,
	list_photos: listPhotosTool,
	get_storage: getStorageTool,
	list_section: listSectionTool,
	get_sharing: getSharingTool,
	read_text_file: readTextFileTool,
	reveal_item: revealItemTool,
	set_favorite: setFavoriteTool,
	create_directory: createDirectoryTool,
	rename_item: renameItemTool,
	move_items: moveItemsTool,
	copy_items: copyItemsTool,
	trash_items: trashItemsTool,
	list_notes: listNotesTool,
	read_note: readNoteTool,
	open_note: openNoteTool,
	create_note: createNoteTool,
	set_note_flags: setNoteFlagsTool,
	list_chats: listChatsTool,
	read_chat: readChatTool,
	open_chat: openChatTool,
	draft_chat_message: draftChatMessageTool,
	find_contacts: findContactsTool,
	list_playlists: listPlaylistsTool,
	open_playlist: openPlaylistTool,
	play: playTool,
	audio_control: audioControlTool,
	add_tracks_to_playlist: addTracksToPlaylistTool,
	get_transfers: getTransfersTool,
	open_route: openRouteTool,
	search_note_text: searchNoteTextTool,
	read_document: readDocumentTool,
	rename_by_pattern: renameByPatternTool,
	organize_by_date: organizeByDateTool,
	restore_items: restoreItemsTool
}

interface ResolvedArgs {
	args: Record<string, unknown>
	targets: AssistantPreviewTarget[]
	text: Record<string, string>
}

function failureOf(error: AssistantToolError): AssistantToolFailure {
	return {
		ok: false,
		invalid: error.invalid,
		error: error.message,
		result: sanitizeStrings({ error: error.message, ...(error.candidates.length > 0 ? { candidates: error.candidates } : {}) }),
		...(error.candidates.length > 0 ? { candidates: error.candidates } : {})
	}
}

function isBlank(value: unknown): boolean {
	return (typeof value === "string" && value.trim().length === 0) || (Array.isArray(value) && value.length === 0)
}

// Whether `path` names a directory of the user's own drive.
async function isDrivePath(path: unknown): Promise<boolean> {
	if (typeof path !== "string" || isBlank(path)) {
		return false
	}

	try {
		await resolveDrivePath(path)

		return true
	} catch (e) {
		if (e instanceof AssistantToolError) {
			return false
		}

		throw e
	}
}

// Checks a tool needs before its confirmation card shows, so the user never confirms a call that then fails.
const PRECHECKS: Partial<Record<AssistantToolName, (scope: ToolScope, input: Record<string, unknown>) => Promise<string | null>>> = {
	...WRITE_PRECHECKS,
	draft_chat_message: draftChatProblem,
	...BATCH_PRECHECKS
}

// The arguments a checked call runs with, where a tool cuts them to what it changes.
const CHECKED_ARGS: Partial<
	Record<AssistantToolName, (scope: ToolScope, input: Record<string, unknown>) => Promise<Record<string, unknown>>>
> = {
	...WRITE_ARGS,
	...BATCH_WRITE_ARGS
}

// Free-text arguments the card shows exactly as the call will use them.
// Names and titles are stored trimmed, so the card shows them trimmed.
const trimmed = (value: string): string => value.trim()

const TEXT_ARGS: Partial<Record<AssistantToolName, Record<string, (value: string) => string>>> = {
	draft_chat_message: { text: draftText },
	create_directory: { name: trimmed },
	rename_item: { new_name: trimmed },
	create_note: { title: trimmed }
}

function notAvailable(tool: AssistantTool): AssistantToolError {
	return new AssistantToolError(`"${tool.title}" is not available yet; the user can do it in the app`)
}

export function createAssistantToolExecutor(): ToolExecutor {
	const registry = new AssistantHandleRegistry()
	// Bumped by reset: a stopped turn's adapter that settles later must not hand the new conversation's
	// registry items it never showed (a handle the model then guesses would name one).
	let generation = 0

	// A plan an earlier conversation's executor held is not this one's.
	clearBatchPlan()

	function scopeFor(
		signal: AssistantSignal | undefined,
		shown: Map<string, AssistantHandleRef>,
		progress?: (progress: AssistantToolProgress) => void,
		calendar: UserCalendar = userCalendar()
	): ToolScope {
		const born = generation

		return {
			registry,
			signal,
			calendar,
			progress,
			show: (entity, name) => {
				if (born !== generation) {
					throw new AssistantToolError("Stopped")
				}

				const ref = registry.register(entity, name)

				shown.set(ref.handle, ref)

				return ref.handle
			}
		}
	}

	// Every handle argument resolved, a path where a handle belongs replaced by the item's handle. The
	// loop validated the schema already.
	async function resolveArgs(tool: AssistantTool, input: Record<string, unknown>, scope: ToolScope): Promise<ResolvedArgs> {
		const kinds = HANDLE_KINDS[tool.name as AssistantToolName] ?? {}
		const required = new Set(toolInputJsonSchema(tool).required ?? [])
		// An optional handle argument the model filled with nothing counts as left out.
		const args: Record<string, unknown> = Object.fromEntries(
			Object.entries(input).filter(([key, value]) => kinds[key] === undefined || required.has(key) || !isBlank(value))
		)
		const targets: AssistantPreviewTarget[] = []
		const text: Record<string, string> = {}

		const shape = TEXT_ARGS[tool.name as AssistantToolName] ?? {}

		for (const [key, value] of Object.entries(args)) {
			const allowed = kinds[key]

			if (allowed === undefined) {
				if (typeof value === "string") {
					const shaped = shape[key]?.(value) ?? value

					// The guard, the card and the adapter all read this one string.
					args[key] = shaped
					text[key] = shaped
				}

				continue
			}

			const handles: string[] = []
			let superseded = false

			for (const handle of Array.isArray(value) ? value.map(String) : [String(value)]) {
				const entity = await resolveHandle(scope, handle, allowed).catch(async (e: unknown) => {
					// A path beside the handle decides in the adapter (list_directory), so a guessed handle there is left
					// out rather than refused: a later turn knows a directory's path from the reply, seldom its handle.
					if (
						key === "handle" &&
						!isConsequentialTool(tool) &&
						e instanceof AssistantToolError &&
						(await isDrivePath(args["path"]))
					) {
						return null
					}

					throw e
				})

				if (entity === null) {
					superseded = true

					break
				}

				// The card names what the adapter will act on: the live row, not the handle's snapshot.
				const live = freshEntity(entity)
				const name = entityName(live)

				// The trash is read-only to the assistant but for restore_items: a move or a favorite there would restore
				// or change what the user threw away.
				if (isConsequentialTool(tool) && tool.name !== "restore_items" && live.kind === "drive" && isTrashed(live.item)) {
					throw new AssistantToolError(`"${name}" is in the trash; only the user can restore or change it, in the app`)
				}
				const resolved = scope.show(entity, name)

				handles.push(resolved)
				targets.push({ handle: resolved, name, ...(live.kind === "chat" ? { recipients: chatRecipients(live.chat) } : {}) })
			}

			if (superseded) {
				delete args["handle"]

				continue
			}

			args[key] = Array.isArray(value) ? handles : handles[0]
		}

		return { args, targets, text }
	}

	return {
		context: options => {
			const shown = new Map<string, AssistantHandleRef>()
			const description = describeContext(scopeFor(undefined, shown), options)

			return Promise.resolve({ description, handles: [ROOT_HANDLE, ...shown.keys()] })
		},

		supports: tool => isAssistantWebTool(tool.name),

		check: async ({ tool, args }) => {
			const shown = new Map<string, AssistantHandleRef>()
			const scope = scopeFor(undefined, shown)

			if (!isAssistantWebTool(tool.name)) {
				return failureOf(notAvailable(tool))
			}

			if (tool.name === "open_route" && UNAVAILABLE_ROUTES.has(args["route"] as AssistantRouteName)) {
				return failureOf(routeUnavailable(String(args["route"])))
			}

			try {
				const full = (await resolveArgs(tool, args, scope)).args
				const resolved = (await CHECKED_ARGS[tool.name]?.(scope, full)) ?? full
				const problem = await PRECHECKS[tool.name]?.(scope, resolved)

				return problem === undefined || problem === null ? { ok: true, args: resolved } : failureOf(new AssistantToolError(problem))
			} catch (e) {
				if (e instanceof AssistantToolError) {
					return failureOf(e)
				}

				throw e
			}
		},

		preview: async ({ tool, args }) => {
			try {
				const scope = scopeFor(undefined, new Map())
				const resolved = await resolveArgs(tool, args, scope)
				const destinations = new Set<unknown>(DESTINATION_ARGS.map(key => resolved.args[key]))
				// A destination by its path: two directories may share a name, never a path.
				const targets = await Promise.all(
					resolved.targets.map(async target => {
						const entity = destinations.has(target.handle) ? registry.get(target.handle)?.entity : undefined
						const path = entity === undefined ? undefined : await destinationPath(entity)

						return path === undefined ? target : { ...target, name: path }
					})
				)

				if (isBatchTool(tool.name)) {
					// The plan lists every file; the scope directory heads the card. Only the call's own text shows.
					const { text, find } = resolved.text

					return {
						ok: true,
						title: tool.title,
						targets: targets.filter(target => destinations.has(target.handle)),
						text: { ...(text === undefined ? {} : { text }), ...(find === undefined ? {} : { find }) },
						batch: await batchPreview(tool.name, scope, args)
					}
				}

				return { ok: true, title: tool.title, targets, text: resolved.text }
			} catch (e) {
				return { ok: false, error: e instanceof AssistantToolError ? e.message : errorLabel(e) }
			}
		},

		execute: async ({ tool, args, confirmed, signal, onProgress, calendar, withoutDocument }) => {
			const shown = new Map<string, AssistantHandleRef>()
			const scope = { ...scopeFor(signal, shown, onProgress, calendar), ...(withoutDocument === true ? { withoutDocument } : {}) }
			if (!isAssistantWebTool(tool.name)) {
				return failureOf(notAvailable(tool))
			}

			const adapter = ADAPTERS[tool.name]

			if (isConsequentialTool(tool) && !confirmed) {
				return failureOf(new AssistantToolError("This needs the user's confirmation first"))
			}

			if (signal.aborted) {
				return failureOf(new AssistantToolError("Stopped"))
			}

			try {
				const output = await unlessStopped(
					resolveArgs(tool, args, scope).then(resolved => adapter(resolved.args, scope)),
					signal
				)

				// Every result, whatever its tool declares: a mis-declared one can never pass raw text through.
				return {
					ok: true,
					result: sanitizeStrings(output.value),
					returned: [...shown.values()]
				}
			} catch (e) {
				if (e instanceof AssistantToolError) {
					return failureOf(e)
				}

				log.warn("assistant", `tool ${tool.name} failed`, e)

				return failureOf(new AssistantToolError(errorLabel(e)))
			}
		},

		name: handle => registry.get(handle)?.ref.name,

		reset: (history: readonly AssistantHistoryTurn[] = []) => {
			generation++
			clearBatchPlan()
			registry.clear(history.flatMap(({ user, reply }) => [user, reply]))
		}
	}
}
