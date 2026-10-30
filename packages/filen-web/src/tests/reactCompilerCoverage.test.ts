import { describe, expect, it } from "vitest"
import { readdirSync } from "node:fs"
import { join } from "node:path"
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

// Each file is compiled once and shared by every function and case that checks it.
const compiled = new Map<string, { events: CompilerEvent[]; code: string }>()

function compileWithCode(file: string): { events: CompilerEvent[]; code: string } {
	const known = compiled.get(file)

	if (known !== undefined) {
		return known
	}

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

	const output = { events, code: result?.code ?? "" }

	compiled.set(file, output)

	return output
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

	it("compiles the DOCX viewer and @filen/office's page list, so a scroll step re-renders only the pages that changed", () => {
		for (const [file, fnName] of [
			["src/features/preview/components/docxViewer.tsx", "DocxPageList"],
			["src/features/preview/components/docxToolbar.tsx", "DocxToolbar"],
			["src/features/preview/components/docxToolbar.tsx", "DocxFindField"],
			["src/features/preview/components/docxAnnotations.tsx", "DocxAnnotationLayer"],
			["src/features/preview/components/docxAnnotations.tsx", "Column"],
			["../filen-office/src/react/docx/annotations/useDocxAnnotations.ts", "useDocxAnnotations"],
			["../filen-office/src/react/docx/DocxPages.tsx", "DocxPages"],
			["../filen-office/src/react/docx/DocxPages.tsx", "DocxPageView"],
			["../filen-office/src/react/docx/useDocxViewer.ts", "useDocxViewer"],
			["../filen-office/src/react/docx/useDocxDocument.ts", "useDocxDocument"]
		] as const) {
			const events = compile(file)

			expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
			expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0)).toBe(
				true
			)
		}
	})

	it("compiles the code editor, its preview and notes surface and the remote-change comparison", () => {
		for (const [file, fnName] of [
			["../filen-office/src/react/code/CodeEditor.tsx", "CodeEditor"],
			["src/features/preview/components/codeMirrorSource.tsx", "CodeMirrorSource"],
			["src/features/preview/components/remoteCompare.tsx", "RemoteCompare"],
			["src/features/preview/components/remoteCompare.tsx", "RemoteFileCompare"],
			["src/features/preview/lib/codeMirrorShared.ts", "useEditorKeymap"],
			["src/features/preview/components/codeSurface.tsx", "CodeSurface"],
			["src/features/preview/components/codeCommandBar.tsx", "CodeCommandBar"],
			["src/features/preview/components/codeCommandBar.tsx", "HistoryButton"],
			["src/features/preview/components/codeCommandBar.tsx", "CodePosition"],
			["src/features/preview/components/codeCommandBar.tsx", "CodeFindField"],
			["src/features/preview/components/codeCommandBar.tsx", "MarkdownModeSwitch"],
			["src/features/preview/components/codeCommandBar.tsx", "MarkdownRenderedBar"],
			["src/features/preview/components/textViewer.tsx", "TextViewer"],
			["src/features/preview/components/markdownViewer.tsx", "MarkdownViewer"]
		] as const) {
			const events = compile(file)

			expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
			expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0)).toBe(
				true
			)
		}
	})

	// About 30 files, the editor's largest among them: some 15 s cold on a loaded machine.
	it("compiles the DOCX editor's view, toolbar, touch selection and hooks", { timeout: 60_000 }, () => {
		for (const [file, fnName] of [
			["src/features/preview/components/docxEditor.tsx", "DocxEditView"],
			["../filen-office/src/react/docx/DocxEditor.tsx", "DocxEditor"],
			["../filen-office/src/react/docx/DocxEditor.tsx", "EditorPage"],
			["src/features/preview/components/docxEditToolbar.tsx", "DocxEditToolbar"],
			["src/features/preview/components/docxEditToolbar.tsx", "CommandButton"],
			["src/features/preview/components/docxFormatControls.tsx", "DocxFormatControls"],
			["src/features/office/components/officeColorGrid.tsx", "DocxColorGrid"],
			["src/features/preview/components/docxTableMenu.tsx", "TableRowsColumns"],
			["src/features/preview/components/docxTableMenu.tsx", "TableDesign"],
			["src/features/preview/components/docxTableMenu.tsx", "TableAlignment"],
			["src/features/preview/components/docxFormControls.tsx", "DocxFormControls"],
			["src/features/preview/components/docxTableBorderDrag.tsx", "DocxTableBorderDrag"],
			["src/features/preview/components/docxHeaderChip.tsx", "DocxHeaderChip"],
			["src/features/preview/components/docxPageSetupDialog.tsx", "DocxPageSetupDialog"],
			["src/features/preview/components/docxContextMenu.tsx", "DocxContextCommands"],
			["src/features/preview/components/docxFields.tsx", "DocxChoiceField"],
			["src/features/preview/components/docxFields.tsx", "DocxRowsColumnsDialog"],
			["src/features/preview/components/docxFormControls.tsx", "ControlListbox"],
			["src/features/preview/components/docxFormControls.tsx", "ItemsEditor"],
			["src/features/preview/components/docxEditor.logic.ts", "useInputForm"],
			["src/features/preview/components/docxReviewLayer.tsx", "DocxReviewLayer"],
			["src/features/preview/components/docxReviewLayer.tsx", "DocxReviewPageOverlay"],
			["src/features/preview/components/docxReviewLayer.tsx", "PageMarks"],
			["src/features/preview/components/docxReviewLayer.tsx", "PageColumn"],
			["src/features/preview/components/docxReviewLayer.tsx", "PageMarkers"],
			["src/features/preview/components/docxReviewLayer.tsx", "Balloon"],
			["src/features/preview/components/docxReviewLayer.tsx", "CommentThreadCard"],
			["src/features/preview/components/docxReviewLayer.tsx", "ChangePopup"],
			["src/features/preview/components/docxReviewMenu.tsx", "DecideMenu"],
			["src/features/preview/components/docxReviewMenu.tsx", "TrackChangesButton"],
			["src/features/preview/components/docxCommentPopover.tsx", "DocxCommentPopover"],
			["src/features/preview/components/docxImageInsert.tsx", "useDocxImageInsert"],
			["src/features/preview/components/docxInsertMenu.tsx", "TableMenu"],
			["src/features/preview/components/docxInsertMenu.tsx", "DocxBreaksMenu"],
			["src/features/preview/components/docxRibbonControls.tsx", "DocxCommandButton"],
			["src/features/preview/components/docxRibbonControls.tsx", "DocxCommandMenu"],
			["src/features/preview/components/docxFormatControls.tsx", "DocxFormatPainter"],
			["src/features/office/components/ribbon/officeRibbon.tsx", "OfficeRibbon"],
			["src/features/office/components/ribbon/officeRibbon.tsx", "CommandRow"],
			["src/features/office/components/ribbon/officeRibbon.tsx", "CollapsedGroup"],
			["src/features/office/components/ribbon/ribbonToolbar.tsx", "RibbonToolbar"],
			["src/features/office/components/ribbon/ribbonControls.tsx", "RibbonButton"],
			["src/features/preview/components/docxInsertDialogs.tsx", "DocxInsertDialogs"],
			["src/features/preview/components/docxDrawingMenu.tsx", "DocxDrawingMenu"],
			["src/features/preview/components/docxObjectHandles.tsx", "DocxObjectHandles"],
			["src/features/preview/components/docxFieldChip.tsx", "DocxFieldChip"],
			["src/features/drive/components/driveFilePickerDialog.tsx", "DriveFilePickerList"],
			["src/features/preview/components/docxEquationPopover.tsx", "DocxEquationPopover"],
			["src/features/preview/components/docxReflowSurface.tsx", "DocxReflowSurface"],
			["../filen-office/src/react/docx/reflow/DocxReflow.tsx", "DocxReflow"],
			["../filen-office/src/react/docx/useDocxEditor.ts", "useDocxEditor"],
			["src/features/preview/components/docxTouchSelection.tsx", "DocxTouchSelection"],
			["src/features/preview/components/docxAuthorGate.tsx", "useDocxAuthorGate"],
			["src/features/preview/components/docxReflow.logic.ts", "useReflowMode"],
			["src/features/settings/components/advanced/documentsRows.tsx", "DocumentsRows"]
		] as const) {
			const events = compile(file)

			expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
			expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0)).toBe(
				true
			)
		}
	})

	it("keeps DocxPages' page frames for the overlay while scrolling within the mounted pages", () => {
		const { events, code } = compileWithCode("../filen-office/src/react/docx/DocxPages.tsx")

		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === "PagesOverlay" && (event.memoSlots ?? 0) > 0)).toBe(
			true
		)
		expect(unguardedCalls(code, "PagesOverlay", ["pageLayout(", "props.overlay("])).toEqual([])
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

	it("compiles the password prompts, the protected-document boundary and its badge", () => {
		for (const [file, fnName] of [
			["src/features/preview/components/docxPasswordPrompt.tsx", "DocxPasswordPrompt"],
			["src/features/preview/components/docxPasswordPrompt.tsx", "DocxPasswordGate"],
			["src/features/preview/components/docxViewer.tsx", "DocxPasswordBoundary"],
			["src/features/preview/components/docxToolbar.tsx", "PasswordBadge"],
			["src/features/preview/components/docxWriteProtection.tsx", "DocxWriteProtectionBar"],
			["src/features/preview/components/docxEditor.tsx", "DocxProtectedEditView"]
		] as const) {
			const events = compile(file)

			expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
			expect(
				events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0),
				fnName
			).toBe(true)
		}
	})

	it.each([
		// A selection toggle re-renders only the toggled add-tracks row.
		["src/features/audio/components/addPlaylistTracksDialog.tsx", "AddTrackRow"],
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
		["src/features/chats/components/chatRow.tsx", "ChatRow"],
		// The events timeline's rows and the page around it.
		["src/features/settings/components/events/eventRow.tsx", "EventRow"],
		["src/features/settings/components/events/eventDayHeader.tsx", "EventDayHeader"],
		["src/features/settings/components/events/eventsSummaryCard.tsx", "EventsSummaryCard"],
		["src/features/settings/components/events/eventsFilters.tsx", "EventsFilters"],
		["src/routes/_app/settings/events.tsx", "EventsPage"]
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

	// useVirtualizer opts its host out, so it lives in eventsTimeline.tsx; a scroll render must not reach the
	// list, and a keystroke or minute tick must not rebuild the describer or the rows.
	it("compiles EventsList, leaving only EventsTimeline to the virtualizer", () => {
		const { events, code } = compileWithCode("src/features/settings/components/events/eventsList.tsx")

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])

		for (const fnName of ["EventsList", "useEventDescriber", "useTimelineRows"]) {
			expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0)).toBe(
				true
			)
		}

		// isEventsFilterActive and isFillCapped return a boolean off a few fields: cheaper than a memo slot.
		expect(unguardedCalls(code, "EventsList", ["newDeviceBadgeKeys(", "findEventEntry("])).toEqual([])
		expect(unguardedCalls(code, "useEventDescriber", ["createEventDescriber("])).toEqual([])
		expect(unguardedCalls(code, "useTimelineRows", ["groupEventsByDay(", "filterEvents("])).toEqual([])
		expect(
			compile("src/features/settings/components/events/eventsTimeline.tsx").filter(event => event.kind !== "CompileSuccess")
		).toHaveLength(1)
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

	// Videos: every card of the home rows and grids with its art hook, the player and its stage (re-rendered by
	// playback), the detail pages and the dialogs. A `??=`, an `x++` captured by a closure, a try with a finally, or
	// a hook result read through `?? fallback` makes the compiler skip the whole function.
	it.each([
		["src/features/videos/components/videoCard.tsx", "VideoCard"],
		["src/features/videos/hooks/useVideoArt.ts", "useVideoArt"],
		["src/features/videos/components/homeRows.tsx", "VideosHomeRows"],
		["src/features/videos/components/homeHero.tsx", "HomeHero"],
		["src/features/videos/components/videosSidebar.tsx", "VideosSidebar"],
		["src/features/videos/screens/videosHome.tsx", "VideosHomeScreen"],
		["src/features/videos/components/detail/movieDetail.tsx", "MovieDetail"],
		["src/features/videos/components/detail/seriesDetail.tsx", "SeriesDetail"],
		["src/features/videos/components/detail/seriesDetail.tsx", "EpisodeRow"],
		["src/features/videos/components/detail/seriesDetail.tsx", "useStoredRuntime"],
		["src/features/videos/components/player/watchScreen.tsx", "WatchScreen"],
		["src/features/videos/components/player/useTitleStill.ts", "useUpNextStill"],
		["src/components/media/video/videoStage.tsx", "VideoStage"],
		["src/features/videos/components/librariesDialog.tsx", "LibrariesDialog"],
		["src/features/videos/components/detail/correctionsDialog.tsx", "CorrectionsDialog"]
	])("compiles %s's %s", (file, fnName) => {
		const events = compile(file)

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0)).toBe(true)
	})

	// useVirtualizer opts its host out, so each Videos list keeps it in a small child: scroll-driven renders reach only
	// that child, and each card or row is compiled on its own.
	it.each([
		["src/features/videos/components/videoGrid.tsx", ["VideoGrid", "GridCard"]],
		["src/features/videos/components/player/episodesPanel.tsx", ["EpisodesPanel", "EpisodeRow"]]
	])("compiles %s, leaving only its rows to the virtualizer", (file, fnNames) => {
		const events = compile(file)

		for (const fnName of fnNames) {
			expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0)).toBe(
				true
			)
		}

		expect(events.filter(event => event.kind !== "CompileSuccess")).toHaveLength(1)
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

	it("memoizes the event dialog's derivations, so a minute tick or a copy skips re-describing the event", () => {
		const { code } = compileWithCode("src/features/settings/components/events/eventDetailDialog.tsx")

		expect(unguardedCalls(code, "EventDetailBody", ["describeEvent("])).toEqual([])
		expect(unguardedCalls(code, "EventDetailContent", ["buildEventDetailView(", "eventLocationUuid(", "eventLookupRef("])).toEqual([])
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
		["src/features/drive/components/newDirectory.tsx", "NewDirectoryDialog"],
		["src/features/drive/components/moveTargetDialog.tsx", "MoveTargetDialog"],
		["src/features/drive/hooks/useUploadMenuActions.tsx", "useUploadMenuActions"],
		["src/features/drive/hooks/useNewOfficeFile.tsx", "useNewOfficeFile"],
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
		["src/features/drive/components/uploadMenu.tsx", "NewMenu"],
		["src/features/drive/components/uploadMenu.tsx", "UploadContextMenu"],
		["src/features/drive/components/sortMenu.tsx", "SortMenu"],
		["src/features/settings/components/events/eventDetailDialog.tsx", "EventDetailDialog"],
		["src/features/settings/components/events/eventDetailDialog.tsx", "DeepLinkedEvent"],
		["src/features/settings/components/events/eventDetailDialog.tsx", "EventDetailBody"],
		["src/features/settings/components/events/eventDetailDialog.tsx", "EventDetailContent"],
		["src/features/settings/components/events/eventDetailRows.tsx", "EventHeroTile"],
		["src/features/settings/components/events/eventDetailRows.tsx", "EventDetailSectionView"],
		["src/features/settings/components/events/eventDetailRows.tsx", "EventDetailRowView"],
		["src/features/settings/components/events/eventDetailRows.tsx", "RawEventView"],
		["src/features/settings/hooks/useEventItemActions.ts", "useEventItemActions"],
		["src/features/drive/components/uploadDropzone.tsx", "UploadDropzone"],
		["src/features/contacts/components/addContactDialog.tsx", "AddContactDialog"],
		["src/features/notes/components/markdownSplitPane.tsx", "MarkdownSplitPane"],
		["src/features/notes/components/noteContentBody.tsx", "NoteContentBody"],
		["src/features/notes/components/editor/checklistEditor.tsx", "ChecklistEditor"],
		["src/features/chats/components/thread/chatsPlaceholder.tsx", "ChatsPlaceholder"],
		["src/features/chats/components/thread/composerSuggestions.tsx", "ComposerSuggestions"],
		["src/features/chats/components/thread/composerModeBanner.tsx", "ComposerModeBanner"],
		["src/features/chats/components/thread/composerModeBanner.tsx", "ReplyTarget"],
		["src/features/assistant/components/assistantPanel.tsx", "AssistantSurface"],
		["src/features/assistant/components/assistantHeader.tsx", "ModelMenu"],
		["src/features/assistant/components/assistantConversation.tsx", "Announcer"],
		["src/features/assistant/components/assistantConfirmationCard.tsx", "AssistantConfirmationCard"],
		["src/features/assistant/components/assistantComposer.tsx", "AssistantComposer"],
		["src/features/assistant/components/assistantSetup.tsx", "SetupBody"]
	])("compiles %s", (file, fnName) => {
		const events = compile(file)

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0)).toBe(true)
	})
})

// The transcript list opts out ("use no memo") for its virtualizer; its rows must still compile, or every
// token landing in the streaming reply would rebuild every visible row.
it("compiles TranscriptRowContent, which renders every assistant transcript row", () => {
	const events = compile("src/features/assistant/components/assistantTranscript.tsx")

	expect(
		events.some(event => event.kind === "CompileSuccess" && event.fnName === "TranscriptRowContent" && (event.memoSlots ?? 0) > 0)
	).toBe(true)
})

// Videos browsing: every card, row and grid host compiles, so a cursor move or a watch-state change re-renders only
// what changed; the grid leaves only its rows to the virtualizer.
describe("Videos browsing compiles", () => {
	it.each([
		["src/features/videos/components/videoCard.tsx", "VideoCard"],
		["src/features/videos/components/videoCard.tsx", "TitleSet"],
		["src/features/videos/components/homeRows.tsx", "HomeRow"],
		["src/features/videos/components/homeRows.tsx", "VideosHomeRows"],
		["src/features/videos/components/homeRows.tsx", "useHomeRows"],
		["src/features/videos/components/homeRows.tsx", "RowCard"],
		["src/features/videos/components/homeHero.tsx", "HomeHero"],
		["src/features/videos/screens/videosSearch.tsx", "VideosSearchScreen"],
		["src/features/videos/screens/videosSearch.tsx", "ResultGroup"],
		["src/features/videos/hooks/useWatchStateLoaded.ts", "useWatchStateLoaded"]
	])("compiles %s %s", (file, fnName) => {
		const events = compile(file)

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0)).toBe(true)
	})

	it("compiles VideoGrid and its cards, leaving only VideoGridRows to the virtualizer", () => {
		const events = compile("src/features/videos/components/videoGrid.tsx")

		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === "GridCard" && (event.memoSlots ?? 0) > 0)).toBe(
			true
		)

		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === "VideoGrid" && (event.memoSlots ?? 0) > 0)).toBe(
			true
		)
		expect(events.filter(event => event.kind !== "CompileSuccess")).toHaveLength(1)
	})

	// The library stays in the SDK worker: the screens only show the rows, pages and results it sends.
	it("builds no rows, grid orders, search index or watch index on the main thread", () => {
		for (const file of [
			"src/features/videos/components/homeRows.tsx",
			"src/features/videos/components/videoGrid.tsx",
			"src/features/videos/screens/videosSearch.tsx",
			"src/features/videos/components/player/watchScreen.tsx"
		]) {
			const code = compileWithCode(file).code

			for (const call of ["buildHomeRows(", "gridView(", "buildVideoSearchIndex(", "buildHomeIndex(", "nextMovieInDirectory("]) {
				expect(code.includes(call), `${file} calls ${call}`).toBe(false)
			}
		}
	})
})

// The PDF viewer re-renders on every page-indicator change and find step: every component and hook of the pages and
// the shell must compile, so such a render reaches only the toolbar and the pages whose matches changed.
describe("React Compiler coverage of the PDF viewer", () => {
	it.each([
		["../filen-office/src/react/pdf/PdfPages.tsx", "PdfPages"],
		["../filen-office/src/react/pdf/PdfPages.tsx", "PdfPageView"],
		["../filen-office/src/react/pdf/usePdfViewer.ts", "usePdfViewer"],
		["../filen-office/src/react/pdf/usePdfDocument.ts", "usePdfDocument"],
		["src/features/preview/components/pdfViewer.tsx", "PdfReader"],
		["src/features/preview/components/pdfViewer.tsx", "PdfDocument"],
		["src/features/preview/components/pdfCommandBar.tsx", "PdfCommandBar"],
		["src/features/preview/components/pdfCommandBar.tsx", "OutlineMenu"],
		["src/features/preview/components/pdfCommandBar.tsx", "PdfPropertiesDialog"],
		["src/features/preview/components/commandBarControls.tsx", "PageControls"],
		["src/features/preview/components/commandBarControls.tsx", "ZoomControls"],
		["src/features/preview/components/commandBarControls.tsx", "CommandFileMenu"],
		["src/features/preview/components/commandBarControls.tsx", "FullScreenButton"],
		["src/features/office/components/ribbon/officeRibbon.tsx", "OfficeCommandBar"],
		["src/features/shell/components/sessionUnreadableScreen.tsx", "SessionUnreadableScreen"]
	])("compiles %s's %s", (file, fnName) => {
		const events = compile(file)

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0)).toBe(true)
	})
})

// The spreadsheet grid draws its cells on canvases outside React, and the shell around it re-renders on every
// selection move and keystroke: each component and hook of the grid and the shell must compile, so such a render
// reaches only the editor, the accessible active cell, the live region and the controls whose props changed.
const SHEET_DIRECTORIES = ["../filen-office/src/react/sheet", "src/features/spreadsheet"]

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { recursive: true, encoding: "utf8" })
		.filter(name => /\.tsx?$/.test(name) && !name.endsWith(".d.ts"))
		.map(name => join(directory, name))
		.sort()
}

describe("React Compiler coverage of the spreadsheet grid and its shell", () => {
	it("bails out of no function in any of their files", { timeout: 60_000 }, () => {
		for (const file of SHEET_DIRECTORIES.flatMap(sourceFiles)) {
			expect(
				compile(file).filter(event => event.kind !== "CompileSuccess"),
				file
			).toEqual([])
		}
	})

	it.each([
		["../filen-office/src/react/sheet/SheetGrid.tsx", "SheetGrid"],
		["../filen-office/src/react/sheet/SheetGrid.tsx", "CellEditor"],
		["../filen-office/src/react/sheet/useSheetGrid.ts", "useSheetGrid"],
		["src/features/spreadsheet/sheetViewer.tsx", "SheetViewer"],
		["src/features/spreadsheet/components/sheetBody.tsx", "SheetBody"],
		["src/features/spreadsheet/components/sheetFormulaBar.tsx", "SheetFormulaBar"],
		["src/features/spreadsheet/components/sheetFormulaBar.tsx", "NameBox"],
		["src/features/spreadsheet/components/sheetGridMenu.tsx", "SheetGridMenu"],
		["src/features/spreadsheet/components/sheetGridMenu.tsx", "ResetItems"],
		["src/features/spreadsheet/toolbar/sheetToolbar.tsx", "SheetToolbar"],
		["src/features/spreadsheet/toolbar/sheetToolbar.tsx", "CommandMenu"],
		["src/features/spreadsheet/toolbar/sheetToolbar.tsx", "useActiveCell"],
		["src/features/spreadsheet/toolbar/sheetToolbar.tsx", "useFormatChoices"],
		["src/features/spreadsheet/toolbar/colorButton.tsx", "SheetColorButton"],
		["src/features/spreadsheet/toolbar/bordersMenu.tsx", "BordersMenu"],
		["src/features/spreadsheet/toolbar/bordersMenu.tsx", "BorderItems"],
		["src/features/spreadsheet/toolbar/fontControls.tsx", "FontPicker"],
		["src/features/spreadsheet/toolbar/alignMenus.tsx", "HorizontalAlignMenu"],
		["src/features/spreadsheet/toolbar/numberFormatMenu.tsx", "NumberFormatMenu"],
		["src/features/spreadsheet/dialogs/formatCells.tsx", "FormatCellsForm"],
		["src/features/spreadsheet/hooks/useSheetSession.ts", "useSheetSession"],
		["src/features/spreadsheet/clipboard/useSheetClipboard.ts", "useSheetClipboard"]
	])("compiles %s's %s", (file, fnName) => {
		const events = compile(file)

		expect(events.filter(event => event.kind !== "CompileSuccess")).toEqual([])
		expect(events.some(event => event.kind === "CompileSuccess" && event.fnName === fnName && (event.memoSlots ?? 0) > 0)).toBe(true)
	})
})
