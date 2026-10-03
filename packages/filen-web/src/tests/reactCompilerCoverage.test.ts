import { describe, expect, it } from "vitest"
import { transformFileSync } from "@babel/core"

// The React Compiler silently skips a hook or component it can't compile, and lint doesn't notice.
// These files are compiled the way vite.config.ts compiles them and must come out compiled.

interface CompilerEvent {
	kind: string
	fnName: string | null
	memoSlots?: number
}

function compile(file: string): CompilerEvent[] {
	return compileWithCode(file).events
}

function compileWithCode(file: string): { events: CompilerEvent[]; code: string } {
	const events: CompilerEvent[] = []

	const result = transformFileSync(file, {
		babelrc: false,
		configFile: false,
		presets: ["@babel/preset-typescript"],
		plugins: [
			// @rolldown/plugin-babel parses a .tsx file's JSX itself; a bare transform needs the syntax plugin.
			...(file.endsWith(".tsx") ? ["@babel/plugin-syntax-jsx"] : []),
			[
				"babel-plugin-react-compiler",
				{
					logger: {
						logEvent: (_filename: string | null, event: CompilerEvent) => {
							events.push(event)
						}
					}
				}
			]
		]
	})

	return { events, code: result?.code ?? "" }
}

// A compiled function can still recompute a value on every render: the compiler drops the memo scope of a
// value whose mutable range spans a hook call. Guarded statements sit inside an `if ($[n] ...)` block, one
// indent level below the function body's own.
function unguardedCalls(code: string, fnName: string, calls: readonly string[]): string[] {
	const start = code.indexOf(`function ${fnName}(`)
	const body = code.slice(start, code.indexOf("\n}\n", start))

	return calls.filter(call => body.split("\n").some(line => /^ {2}\S/.test(line) && line.includes(call)))
}

describe("React Compiler coverage", () => {
	it("compiles useDriveDropTarget, which every directory row, tile, tree node and crumb runs", () => {
		const events = compile("src/features/drive/hooks/useDriveDropTarget.ts")

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(
			events.some(event => event.kind === "CompileSuccess" && event.fnName === "useDriveDropTarget" && (event.memoSlots ?? 0) > 0)
		).toBe(true)
	})

	it("compiles useDriveClipboard, which every drive listing runs", () => {
		const events = compile("src/features/drive/hooks/useDriveClipboard.ts")

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(
			events.some(event => event.kind === "CompileSuccess" && event.fnName === "useDriveClipboard" && (event.memoSlots ?? 0) > 0)
		).toBe(true)
	})

	it("compiles useListingOpen, DriveRow and DriveTile, so a listing scroll step reuses each cell's menu subtree", () => {
		// DirectoryListing itself opts out ("use no memo"); only its module-level open hook must compile.
		const listing = compile("src/features/drive/components/directoryListing.tsx")

		expect(listing.filter(event => event.kind !== "CompileSuccess" && event.kind !== "CompileSkip")).toEqual([])
		expect(
			listing.some(event => event.kind === "CompileSuccess" && event.fnName === "useListingOpen" && (event.memoSlots ?? 0) > 0)
		).toBe(true)

		for (const [file, fnName] of [
			["src/features/drive/components/driveRow.tsx", "DriveRow"],
			["src/features/drive/components/driveTile.tsx", "DriveTile"]
		] as const) {
			const events = compile(file)

			expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
			expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0)).toBe(
				true
			)
		}
	})

	it("compiles useDriveListboxNav, so a listing render reuses its row keys and hands rows stable handlers", () => {
		const { events, code } = compileWithCode("src/features/drive/hooks/useDriveListboxNav.ts")

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(
			events.some(event => event.kind === "CompileSuccess" && event.fnName === "useDriveListboxNav" && (event.memoSlots ?? 0) > 0)
		).toBe(true)
		expect(
			unguardedCalls(code, "useDriveListboxNav", [
				"items.map(driveRowKey)",
				"function handlePointerSelect(",
				"function handleKeyDown(",
				"function setCursor("
			])
		).toEqual([])
	})

	it("compiles the archive browser, its rows and footer, so a listing notification re-renders only what changed", () => {
		for (const [file, fnName] of [
			["src/features/archive/components/archiveBrowser.tsx", "ArchiveBrowser"],
			["src/features/archive/components/archiveBrowser.tsx", "ArchiveSourceBrowser"],
			["src/features/archive/components/archiveEntryRow.tsx", "ArchiveEntryRow"],
			["src/features/archive/components/archiveFooter.tsx", "ArchiveFooter"]
		] as const) {
			const events = compile(file)

			expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
			expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0)).toBe(
				true
			)
		}
	})

	it("compiles QueueRow, so a track change re-renders only the queue rows whose props changed", () => {
		const events = compile("src/features/audio/components/nowPlayingPanel.tsx")

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === "QueueRow" && (event.memoSlots ?? 0) > 0)).toBe(
			true
		)
	})

	it("compiles GridCell, so a scroll step, selection move or keystroke re-renders only the cells that changed", () => {
		const events = compile("src/features/spreadsheet/components/sheetGrid.tsx")

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === "GridCell" && (event.memoSlots ?? 0) > 0)).toBe(
			true
		)
	})

	it.each([
		// A selection toggle re-renders only the toggled add-tracks row.
		["src/features/audio/components/addPlaylistTracksDialog.tsx", "AddTrackRow"],
		// A current-page change skips every PdfPage.
		["src/features/preview/components/pdfViewer.tsx", "PdfPages"],
		// The media players: a playhead tick re-renders only the parts that read the playhead.
		["src/lib/media/useMediaState.ts", "useMediaValue"],
		["src/lib/media/useMediaState.ts", "useSyncedMediaVolume"],
		["src/components/media/sliderVisual.tsx", "SliderVisual"],
		["src/components/media/mediaScrubber.tsx", "MediaScrubber"],
		["src/components/media/mediaScrubber.tsx", "MediaElementScrubber"],
		["src/components/media/mediaTime.tsx", "MediaCurrentTime"],
		["src/components/media/mediaTime.tsx", "MediaDuration"],
		["src/components/media/volumeControl.tsx", "VolumeControl"],
		["src/features/preview/components/videoPlayer.tsx", "VideoPlayer"],
		["src/features/preview/components/videoPlayer.tsx", "PlaybackSpeedMenu"],
		["src/features/preview/components/videoPlayer.tsx", "PictureInPictureButton"],
		["src/features/preview/components/videoPlayer.tsx", "FullscreenButton"],
		["src/features/audio/components/audioPlayerBar.tsx", "AudioPlayerBar"],
		["src/features/audio/components/audioPlayerBar.tsx", "PlayerBarTimeline"],
		["src/features/audio/components/audioPlayerBar.tsx", "TrackTitle"],
		// Mounted by every row and tile of the click-to-select lists.
		["src/lib/useTouchLongPress.ts", "useTouchLongPress"],
		["src/features/photos/components/photoTile.tsx", "PhotoTile"],
		["src/features/notes/components/noteRow.tsx", "NoteRow"],
		["src/features/chats/components/chatRow.tsx", "ChatRow"]
	])("compiles %s's %s", (file, fnName) => {
		const events = compile(file)

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0)).toBe(true)
	})

	// useVirtualizer opts its host out, so it lives in each sidebar's list child; its scroll-driven renders must
	// not reach the sidebar, and the sidebar's row model must not rebuild on an unrelated render.
	it.each([
		[
			"src/features/notes/components/notesSidebar.tsx",
			"NotesSidebar",
			[
				"filterNotesByBlockedOwner(",
				"buildNotesGroupedRows(",
				"buildTagsViewRows(",
				"selectableNotesFromRows(",
				"selectableRowIndexByKey(",
				"new Map(",
				"new Set("
			]
		],
		[
			"src/features/chats/components/chatsSidebar.tsx",
			"ChatsSidebar",
			["chatsWithoutBlockedOneOnOne(", "filterChats(", "new Map(", ".sort()", "new Set("]
		]
	])("compiles %s, leaving only its list child to the virtualizer", (file, fnName, derivations) => {
		const { events, code } = compileWithCode(file)

		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0)).toBe(true)
		expect(events.filter(event => event.kind !== "CompileSuccess")).toHaveLength(1)
		expect(unguardedCalls(code, fnName, derivations)).toEqual([])
	})

	it("compiles DriveSidebar, so non-drive navigations skip the mounted directory tree", () => {
		const events = compile("src/features/shell/components/driveSidebar.tsx")

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === "DriveSidebar" && (event.memoSlots ?? 0) > 0)).toBe(
			true
		)
	})

	// A try without a catch is what the compiler cannot lower; this re-renders on every keystroke.
	it("compiles the chat Composer", () => {
		const events = compile("src/features/chats/components/thread/composer.tsx")

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === "Composer" && (event.memoSlots ?? 0) > 0)).toBe(
			true
		)
	})

	// useVirtualizer opts its host out, so it lives in PhotoGridRows; its scroll-driven renders must not reach PhotoGrid.
	it("compiles PhotoGrid, leaving only PhotoGridRows to the virtualizer", () => {
		const events = compile("src/features/photos/components/photoGrid.tsx")

		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === "PhotoGrid" && (event.memoSlots ?? 0) > 0)).toBe(
			true
		)
		expect(events.filter(event => event.kind !== "CompileSuccess")).toHaveLength(1)
	})

	it("memoizes PhotoGrid's derivations, so a keystroke, selection change or resize skips re-filtering the library", () => {
		const grid = compileWithCode("src/features/photos/components/photoGrid.tsx")
		const filter = compileWithCode("src/features/photos/hooks/usePhotosFilter.ts")

		expect(
			unguardedCalls(grid.code, "PhotoGrid", [
				"reconcileSelectedItems(",
				"new Set(",
				"buildPhotosTimeline(",
				"function handleOpenAt(",
				"function handleTileClick("
			])
		).toEqual([])
		expect(filter.events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(unguardedCalls(filter.code, "usePhotosFilter", ["photoKindsPresent(", "filterPhotos("])).toEqual([])
	})

	// useVirtualizer opts ThreadList out; the rows it maps must come from compiled ThreadRowContent so a scroll
	// render skips every unchanged MessageRow.
	it.each([
		["src/features/drive/components/compressDialog.tsx", "CompressDialogForm"],
		["src/features/drive/components/extractDialog.tsx", "ExtractDialog"]
	])("compiles %s's %s, whose async submit holds no finally", (file, fnName) => {
		const events = compile(file)

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0)).toBe(true)
	})

	it("compiles ThreadRowContent, leaving only ThreadList to the virtualizer", () => {
		const events = compile("src/features/chats/components/thread/messageThread.tsx")

		for (const fnName of ["ThreadRowContent", "TimeHeader", "UnreadDivider"]) {
			expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0)).toBe(
				true
			)
		}

		expect(events.filter(event => event.kind !== "CompileSuccess")).toHaveLength(1)
	})

	// Every thread row renders through these, and the typing bubble through the last.
	it.each([
		["src/features/chats/components/thread/messageRow.tsx", "MessageRow"],
		["src/features/chats/components/thread/messageRow.tsx", "BubbleTail"],
		["src/features/chats/components/thread/messageContent.tsx", "MessageContent"],
		["src/features/chats/components/thread/typingIndicator.tsx", "TypingIndicator"]
	])("compiles %s's %s", (file, fnName) => {
		const events = compile(file)

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0)).toBe(true)
	})

	// A destructuring default is what the compiler cannot lower; each of these had one.
	it.each([
		["src/features/drive/components/newDirectory.tsx", "NewDirectory"],
		["src/features/drive/components/moveTargetDialog.tsx", "MoveTargetDialog"],
		["src/features/drive/hooks/useUploadMenuActions.tsx", "useUploadMenuActions"],
		["src/components/ui/alert-dialog.tsx", "AlertDialogContent"],
		["src/components/ui/alert-dialog.tsx", "AlertDialogCancel"],
		["src/components/ui/avatar.tsx", "Avatar"],
		["src/components/ui/badge.tsx", "Badge"],
		["src/components/ui/button.tsx", "Button"],
		["src/components/ui/card.tsx", "Card"],
		["src/components/ui/context-menu.tsx", "ContextMenuContent"],
		["src/components/ui/context-menu.tsx", "ContextMenuItem"],
		["src/components/ui/dialog.tsx", "DialogContent"],
		["src/components/ui/dialog.tsx", "DialogFooter"],
		["src/components/ui/dropdown-menu.tsx", "DropdownMenuContent"],
		["src/components/ui/dropdown-menu.tsx", "DropdownMenuItem"],
		["src/components/ui/dropdown-menu.tsx", "DropdownMenuSubContent"],
		["src/components/ui/empty.tsx", "EmptyMedia"],
		["src/components/ui/field.tsx", "Field"],
		["src/components/ui/popover.tsx", "PopoverContent"],
		["src/components/ui/select.tsx", "SelectTrigger"],
		["src/components/ui/select.tsx", "SelectContent"],
		["src/components/ui/separator.tsx", "Separator"],
		["src/components/ui/switch.tsx", "Switch"],
		["src/components/ui/tooltip.tsx", "TooltipProvider"],
		["src/components/ui/tooltip.tsx", "TooltipContent"],
		["src/providers/themeProvider.tsx", "ThemeProvider"],
		["src/components/dialogs/confirmDialog.tsx", "ConfirmDialog"],
		["src/components/dialogs/typedConfirmDialog.tsx", "TypedConfirmDialog"],
		["src/features/publicLinks/components/saveToDrive.tsx", "SaveToDriveButton"],
		["src/features/publicLinks/components/publicArchive.tsx", "PublicArchiveBrowser"],
		["src/features/publicLinks/components/publicArchive.tsx", "PublicArchiveActions"],
		["src/features/publicLinks/components/publicArchive.tsx", "ExtractToDriveButton"],
		["src/features/publicLinks/components/publicArchive.tsx", "SaveAsArchiveButton"],
		["src/features/publicLinks/components/fileHero.tsx", "FileHero"],
		["src/features/drive/components/destinationMenu.tsx", "DestinationEntries"],
		["src/features/drive/components/uploadMenu.tsx", "UploadMenu"],
		["src/features/drive/components/uploadMenu.tsx", "UploadContextMenu"],
		["src/features/drive/components/sortMenu.tsx", "SortMenu"],
		["src/features/drive/components/uploadDropzone.tsx", "UploadDropzone"],
		["src/features/contacts/components/addContactDialog.tsx", "AddContactDialog"],
		["src/features/notes/components/markdownSplitPane.tsx", "MarkdownSplitPane"],
		["src/features/notes/components/noteContentBody.tsx", "NoteContentBody"],
		["src/features/notes/components/editor/checklistEditor.tsx", "ChecklistEditor"],
		["src/features/chats/components/thread/chatsPlaceholder.tsx", "ChatsPlaceholder"],
		["src/features/chats/components/thread/composerSuggestions.tsx", "ComposerSuggestions"],
		["src/features/chats/components/thread/composerModeBanner.tsx", "ComposerModeBanner"],
		["src/features/chats/components/thread/composerModeBanner.tsx", "ReplyTarget"]
	])("compiles %s", (file, fnName) => {
		const events = compile(file)

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0)).toBe(true)
	})
})
