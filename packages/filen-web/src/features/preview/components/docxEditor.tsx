import { useDeferredValue, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { bytesSource } from "@filen/office/core/opc"
import {
	DOCX_PARAGRAPH_STYLES,
	STORY_FIND_LIMIT,
	docxFontList,
	findInStory,
	isWriteCommand,
	offeredParagraphStyles,
	replaceAll,
	replaceMatches,
	selectMatch,
	type DocxEditorCommand,
	type DocxEditorCommandType,
	type DocxFontChoice,
	type DocxParagraphStyle,
	type DocxWriteProtection,
	type StoryMatch,
	writeProtectionOf
} from "@filen/office/core/docx/edit"
import type { PagedEditor } from "@filen/office/core/docx/paged"
import type { SpellingIssue, SpellingMark } from "@filen/office/core/docx/spelling"
import { DocxSpelling } from "@filen/office/core/docx/spelling"
import { DocxSaveError } from "@filen/office/core/docx/write"
import {
	DEFAULT_MARKUP_MODE,
	clampZoom,
	fitWidthZoom,
	markupInfo,
	stepZoom,
	type DocxMarkupMode,
	type DocxUnlockedDocument
} from "@filen/office/dom/docx"
import type { DocxEditingHost, DocxSealer } from "@filen/office/dom/docx/editing"
import type { DocxSaveNotice } from "@filen/office/dom/docx/save"
import { useDocxDocument, type DocxSource } from "@filen/office/react/docx"
import {
	DocxEditor,
	plainText,
	useDocxEditor,
	type DocxEditorHandle,
	type DocxObjectPress,
	type DocxPageOverlay
} from "@filen/office/react/docx/editor"
import "@filen/office/css/docx.css"
import "@filen/office/css/docx-review.css"
import "@filen/office/css/docx-objects.css"
import "@filen/office/css/docx-reflow.css"
import { DOCX_FONT_URLS } from "@/features/preview/lib/docxEngine"
import { readEditorClipboard, writeEditorClipboard } from "@/features/preview/lib/docxClipboard"
import { FormatSaveError } from "@/features/preview/lib/rtfEditing"
import {
	assertSealedUpload,
	docxEditingHost,
	takeProtectedDocument,
	writeDocx,
	type DocxEditingBackend,
	type DocxSaveSnapshot,
	type DocxTakenSession
} from "@/features/preview/lib/docxEditing"
import {
	AUTOSAVE_IDLE_MS,
	editorMarkupView,
	featureEditable,
	editorMarks,
	featureLanded,
	editorViewOnlyReasons,
	firstMatchFrom,
	markupRelayout,
	objectInteractions,
	replaceAllToast,
	shownMarkup,
	sameToolbarSnapshot,
	stepMatch,
	themeSwatches,
	type DocxInputRequest,
	type DocxPainterState,
	type DocxSurface,
	type DocxSwatch
} from "@/features/preview/components/docxEditor.logic"
import { commandNeedsAuthor } from "@/features/preview/components/docxAuthorGate.logic"
import { useDocxAuthorGate } from "@/features/preview/components/docxAuthorGate"
import { DocxCommentPopover } from "@/features/preview/components/docxCommentPopover"
import { DocxContextCommands } from "@/features/preview/components/docxContextMenu"
import { DocxEditToolbar, type DocxRibbonClipboard } from "@/features/preview/components/docxEditToolbar"
import { DocxFileMenu } from "@/features/preview/components/docxFileMenu"
import { ribbonLanding } from "@/features/office/components/ribbon/ribbonFocus"
import { useDocxPdfExport } from "@/features/preview/hooks/useDocxPdfExport"
import { editedFile } from "@/features/preview/lib/docxLiveFile"
import type { LiveFile } from "@/features/drive/lib/downloadAs"
import type { PasswordIntegrity } from "@/features/preview/components/docxToolbar"
import { DocxEquationPopover } from "@/features/preview/components/docxEquationPopover"
import { DocxFieldChip } from "@/features/preview/components/docxFieldChip"
import { DocxFormControls } from "@/features/preview/components/docxFormControls"
import { DocxParagraphDialog } from "@/features/preview/components/docxFormatControls"
import { DocxHeaderChip } from "@/features/preview/components/docxHeaderChip"
import { DocxLayoutBusy } from "@/features/preview/components/docxLayoutBusy"
import { DocxPageSetupDialog } from "@/features/preview/components/docxPageSetupDialog"
import { DocxTableBorderDrag } from "@/features/preview/components/docxTableBorderDrag"
import { DocxTableSplitDialog } from "@/features/preview/components/docxTableMenu"
import { useDocxImageInsert } from "@/features/preview/components/docxImageInsert"
import { useReflowMode } from "@/features/preview/components/docxReflow.logic"
import { DocxWriteProtectionBar } from "@/features/preview/components/docxWriteProtection"
import { DocxReflowSurface } from "@/features/preview/components/docxReflowSurface"
import { DocxDrawingPress, DocxObjectHandles } from "@/features/preview/components/docxObjectHandles"
import { DocxReviewLayer, DocxReviewPageOverlay } from "@/features/preview/components/docxReviewLayer"
import { BALLOON_COLUMN_WIDTH, balloonsFit, type DocxFindControls } from "@/features/preview/components/docxViewer.logic"
import { DocxTouchSelection } from "@/features/preview/components/docxTouchSelection"
import { SaveRefusedError } from "@/features/drive/lib/previewSave.logic"
import { defaultSpellingLanguage, documentSpellingChecker } from "@/features/spellcheck/lib/spellcheck"
import { loadOfficeSettings, saveOfficeAutosave, useOfficeSettings } from "@/features/office/lib/officeSettings"
import { E2E_AUTOSAVE_OFF } from "@/features/office/lib/officeAutosave"
import { LoadingState } from "@/components/loadingState"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu"
import { isAnyDialogOpen } from "@/lib/keymap/dialogGuard"
import { isMacPlatform } from "@/lib/keymap/kbd.logic"
import { IN_EDITORS, useAction } from "@/lib/keymap/useAction"
import { log } from "@/lib/log"
import { useElementSize } from "@/lib/useElementSize"
import { useIsOnline } from "@/lib/useIsOnline"
import { useLatestRef } from "@/lib/useLatestRef"

// A Word document edited in place: the paged editor (@filen/office) on the page's own thread, its toolbar,
// find and replace, spelling (marks, and suggestions in the context menu), clipboard commands, touch
// selection, and the overlay's save path (`saveRef`, idle autosave). Opened only for a file the user may
// edit in their drive; everything else is shown by the viewer in its worker.

// The overlay's handle on the edited document: writes it (still editable meanwhile: the writer reads it as it
// starts) and returns the file with the call that marks what it holds saved once stored.
// `auto`: an idle autosave (a refusal holds autosave and is not shown as a failure; only an explicit save
// looks for the blocks to write as last saved).
export type DocxSaveSource = (options?: { auto?: boolean }) => Promise<DocxSaveSnapshot>

const PAGE_GAP = 16
const WHEEL_SENSITIVITY = 0.0015
const LAYER = "[role='dialog'], [role='alertdialog']"
const APPLE = isMacPlatform()
const NO_MATCHES: readonly StoryMatch[] = []
const NO_SPELLING: readonly SpellingMark[] = []
// The toast shown while a save looks for the blocks the writer refuses.
const SEARCH_TOAST = "docx-save-search"
// Suggestions a context menu offers.
const MAX_SUGGESTIONS = 6

// The document open for editing, laid out first as a markup mode's view shows revisions (another view is laid
// out in place once it is open).
interface Opened {
	editing: DocxEditingHost
	source: DocxSource
}

// `writeUnlocked`: the document's password to modify was given (docxWriteProtection.tsx). `encryption`: it was
// opened with its password, and saves are sealed with its key.
// `backend`: the proof and writer of a document saved in another format (an RTF document).
function openEditing(
	bytes: Uint8Array,
	mode: DocxMarkupMode,
	writeUnlocked = false,
	encryption?: DocxSealer,
	backend?: DocxEditingBackend
): Opened {
	const editing = docxEditingHost(writeUnlocked, encryption, backend)

	return {
		editing,
		source: { host: editing.host, bytes: bytesSource(bytes), options: { fontUrls: DOCX_FONT_URLS, view: markupInfo(mode).view } }
	}
}

interface Ready {
	opened: Opened
	editor: PagedEditor
	spelling: DocxSpelling
	// The style picker's styles (protection may lock some) and the colour pickers' theme colours.
	styles: readonly DocxParagraphStyle[]
	theme: readonly (readonly DocxSwatch[])[]
	// Password to modify or read-only recommended (w:writeProtection).
	writeProtection: DocxWriteProtection | undefined
}

interface FindState {
	open: boolean
	// Opened as "Find and replace".
	replace: boolean
	// Bumped to focus the field again.
	focus: number
	query: string
	caseSensitive: boolean
	// The current match; -1 until a search picks one (the first after the caret).
	active: number
}

const FIND_CLOSED: FindState = { open: false, replace: false, focus: 0, query: "", caseSensitive: false, active: -1 }

// What a context menu was opened on: a position, and the spelling issue there with its suggestions.
interface MenuTarget {
	pos: number
	issue: SpellingIssue | undefined
	suggestions: readonly string[] | undefined
}

// What features draw over each page once offered.
const REVIEW_OVERLAY = featureLanded("comments") || featureLanded("review")
const OBJECT_OVERLAY = featureLanded("drawings")

// What `execute` runs before the view's first commit.
function executeNothing(): void {
	return undefined
}

// Every input request gets its own (DocxInputRequest.nonce).
let inputNonce = 0

function subscribeNothing(): () => void {
	return () => undefined
}

// Whether an event comes from the review layer (balloons, comment fields), which handles its own input.
function inReview(target: EventTarget | null): boolean {
	return target instanceof Element && target.closest("[data-docx-review]") !== null
}

function noSpelling(): readonly SpellingMark[] {
	return NO_SPELLING
}

const NO_FONTS: readonly DocxFontChoice[] = []

interface OverlayElement {
	readonly page: DocxPageOverlay
	readonly editor: PagedEditor
	readonly markup: DocxMarkupMode
	readonly press: DocxObjectPress | null
	readonly readOnly: boolean
	readonly element: ReactNode
}

interface SaveSourceOptions {
	host: DocxEditingHost
	editor: PagedEditor
	// Opened with its password: what is handed to the upload must be sealed.
	encrypted: boolean
	// The file was stored: what it holds is saved.
	onSaved: () => void
	// The writer refused (an autosave, or an explicit save nothing resolved): autosave holds until a save.
	onRefused: () => void
	// Edited blocks went back to how they were last saved so the rest could be stored (told once stored).
	onLocked: (locked: { count: number; text: string; reverted: number }) => void
	// The search for the blocks the writer refuses runs (it runs the writer several times): shown meanwhile.
	onSearch: (searching: boolean) => void
	// The file's own writer stored something otherwise than the editor has it (told once stored).
	onNotices: (notices: readonly DocxSaveNotice[]) => void
}

// The document's text as edited, for keeping edits a save could not write: the body (list numbers
// included), then each other story with unsaved edits (headers, footers, notes), in the order they opened.
function documentText(editor: PagedEditor): string {
	const body = editor.body.session
	const parts: string[] = []

	for (const session of editor.sessions) {
		if (session !== body && !session.snapshot().dirty) {
			continue
		}

		const doc = session.state.doc

		parts.push(plainText(doc, 0, doc.content.size, pos => (session === body ? editor.geometry.markerText(pos) : "")))
	}

	return parts.join("\n\n")
}

// Writes the document for the overlay's save. The writer reads the documents once, as it starts, so the editor
// stays editable: what is typed meanwhile is not in this file, stays unsaved, and goes with the next save. Blocks
// the writer refuses on an explicit save are written as last saved and taken back once the file is stored (the
// user is told then); a refusal nothing resolves keeps the document open and unsaved, with its text to copy. An
// autosave never searches: a refusal holds autosave, quietly.
function docxSaveSource({ host, editor, encrypted, onSaved, onRefused, onLocked, onSearch, onNotices }: SaveSourceOptions): DocxSaveSource {
	return async (options = {}) => {
		const auto = options.auto === true

		// Set from writeDocx's callback.
		const search = { started: false }

		try {
			const written = await writeDocx(host, {
				auto,
				onSearch: () => {
					search.started = true
					onSearch(true)
				}
			})

			// Never the decrypted package to the upload (the host seals; checked again here, at the hand-off).
			assertSealedUpload(written.bytes, encrypted)
			log.info("docx", "document written", { bytes: written.bytes.byteLength, ms: Math.round(written.elapsedMs), encrypted })

			return {
				...written,
				commit: () => {
					written.commit()
					onSaved()

					if (written.locked !== undefined) {
						onLocked(written.locked)
					}

					if (written.notices !== undefined && written.notices.length > 0) {
						onNotices(written.notices)
					}
				}
			}
		} catch (error) {
			if (error instanceof DocxSaveError) {
				log.error("docx", "save refused", { reason: error.reason, message: error.message, auto })
				onRefused()

				if (auto) {
					throw new SaveRefusedError("previewDocxSaveRefused", { silent: true })
				}

				const text = documentText(editor)

				throw new SaveRefusedError(error instanceof FormatSaveError ? error.messageKey : "previewDocxSaveRefused", {
					action: {
						labelKey: "previewDocxSaveRefusedCopy",
						run: () => {
							void writeEditorClipboard({ text })
						}
					}
				})
			}

			throw error
		} finally {
			if (search.started) {
				onSearch(false)
			}
		}
	}
}

export interface DocxEditViewProps {
	bytes: Uint8Array
	alt: string
	// Saving is possible (a rename to another format, or a save failing for good, turns it off).
	writable: boolean
	renamed: boolean
	onDirtyChange: (dirty: boolean) => void
	saveRef: RefObject<DocxSaveSource | null>
	// Idle autosave: asks the overlay to save through its own save path; true when a save started.
	onAutosave: () => boolean
	// The viewer, for a document the editor cannot open (it shows its own error or fallback).
	viewer: () => ReactNode
	// Opened with its password (docxViewer.tsx): every save is sealed with its key, never stored decrypted.
	encryption?: DocxSealer | undefined
	// Whether the encrypted package's integrity was verified (the badge warns when it could not be).
	encryptionIntegrity?: PasswordIntegrity | undefined
	// The editor opened on `bytes` (each time it opens).
	onEditorOpened?: (() => void) | undefined
	// A password-protected file as stored: a PDF of it asks for, checks and keeps its password.
	encryptedFile?: Uint8Array | undefined
	// The document is saved in another format (an RTF document: rtfEditing.ts): its proof and writer.
	backend?: DocxEditingBackend | undefined
}

export type DocxProtectedEditViewProps = Omit<DocxEditViewProps, "bytes" | "encryption" | "encryptionIntegrity"> & {
	// Unlocked where the viewer's engine holds it: the editor takes its own copy and the key to seal saves.
	document: DocxUnlockedDocument
}

// The editor on a password-protected document: its decrypted package and key taken to this thread (the viewer
// never has them), every save sealed with that key, the key released once the editor closes and no seal runs.
// A copy that cannot be taken leaves the document to the viewer.
export function DocxProtectedEditView({ document, ...props }: DocxProtectedEditViewProps) {
	const [taken, setTaken] = useState<{ document: DocxUnlockedDocument; session: DocxTakenSession | null } | null>(null)
	const current = taken?.document === document ? taken.session : undefined

	useEffect(() => {
		const controller = new AbortController()
		let session: DocxTakenSession | null = null

		takeProtectedDocument(document, controller.signal).then(
			opened => {
				if (controller.signal.aborted) {
					opened.close()

					return
				}

				session = opened
				setTaken({ document, session: opened })
			},
			(error: unknown) => {
				if (!controller.signal.aborted) {
					log.error("docx", "the protected document could not be taken for editing", error)
					setTaken({ document, session: null })
				}
			}
		)

		return () => {
			controller.abort()
			session?.close()
		}
	}, [document])

	if (current === undefined) {
		return (
			<LoadingState
				size="lg"
				className="size-full text-inherit"
			/>
		)
	}

	if (current === null) {
		return props.viewer()
	}

	return (
		<DocxEditView
			{...props}
			bytes={current.bytes}
			encryption={current.sealer}
			encryptionIntegrity={document.integrity}
			// The editor has its own copy now: the one the viewer's engine held goes (a fallback viewer after that
			// shows the error state).
			onEditorOpened={() => {
				document.dropPackage()
			}}
		/>
	)
}

export function DocxEditView({
	bytes,
	alt,
	writable,
	renamed,
	onDirtyChange,
	saveRef,
	onAutosave,
	viewer,
	encryption,
	encryptionIntegrity,
	onEditorOpened,
	encryptedFile,
	backend
}: DocxEditViewProps) {
	const { t } = useTranslation("preview")
	const [markupMode, setMarkupMode] = useState<DocxMarkupMode>(DEFAULT_MARKUP_MODE)
	const [opened, setOpened] = useState(() => openEditing(bytes, DEFAULT_MARKUP_MODE, false, encryption, backend))
	const document = useDocxDocument(opened.source)
	const [ready, setReady] = useState<Ready | null>(null)
	const current = ready?.opened === opened ? ready : null
	const openedRef = useLatestRef(onEditorOpened)
	const editor = current?.editor
	const spelling = current?.spelling
	// The font picker's fonts, read once the editor is open.
	const [fonts, setFonts] = useState<{ editor: PagedEditor; fonts: readonly DocxFontChoice[] } | null>(null)
	const controls = useDocxEditor(editor)
	const snapshot = controls.state?.snapshot
	// What the toolbar shows: the snapshot it was last given while nothing it shows changed (a keystroke
	// changes the selection and the version only), so typing re-renders no toolbar.
	const [toolbarSnapshot, setToolbarSnapshot] = useState(snapshot)

	if (toolbarSnapshot !== snapshot && !sameToolbarSnapshot(toolbarSnapshot, snapshot)) {
		setToolbarSnapshot(snapshot)
	}

	const handleRef = useRef<DocxEditorHandle | null>(null)
	// Describes the editing area to screen readers while it can be edited: Tab stays in it, Escape leaves.
	const keysId = useId()
	const describedBy = writable ? keysId : undefined
	const [wrapper, setWrapper] = useState<HTMLDivElement | null>(null)
	const rootRef = useRef<HTMLDivElement | null>(null)
	const { width } = useElementSize(wrapper)
	// The writer refused the document: autosave waits for an explicit save (which can resolve it).
	const [autosaveHeld, setAutosaveHeld] = useState(false)
	const [zoomMode, setZoomMode] = useState<"fit" | number>("fit")
	const [find, setFind] = useState<FindState>(FIND_CLOSED)
	const [menu, setMenu] = useState<MenuTarget | null>(null)
	// The last press on the pages was a touch: selections get handles and the touch menu.
	const [touch, setTouch] = useState(false)
	// The reflowed view (Mobile view) in place of the pages.
	const { reflow, setReflow } = useReflowMode(width)
	const surface: DocxSurface = reflow ? "reflow" : "pages"
	// A command's input asked of the component that takes it (a comment's text, an equation), until it is done.
	const [inputRequest, setInputRequest] = useState<DocxInputRequest | null>(null)
	const [requestInput] = useState(() => (type: DocxEditorCommandType, detail?: string): void => {
		inputNonce += 1
		setInputRequest({ type, nonce: inputNonce, ...(detail === undefined ? {} : { detail }) })
	})
	const [onInputDone] = useState(() => (nonce: number): void => {
		setInputRequest(previous => (previous?.nonce === nonce ? null : previous))
	})
	const inputChannel = { inputRequest, requestInput, onInputDone }
	// One function for the editor's lifetime: the toolbar's buttons take no new props on a keystroke. It runs
	// the latest executeCommand (set after commit, below), which the author gate it is given to precedes.
	const executeRef = useRef<(command: DocxEditorCommand) => void>(executeNothing)
	const [execute] = useState(() => (command: DocxEditorCommand): void => {
		executeRef.current(command)
	})
	const settings = useOfficeSettings()
	const { withAuthor, dialog: authorDialog } = useDocxAuthorGate({ authorName: settings.authorName, editor, execute })
	// Each mounted page's overlay element and what it was made from (overlays, below).
	const [overlayElements] = useState(() => new Map<number, OverlayElement>())
	// The object a press on the pages hit, for the feature that acts on it (handles, pickers, popovers).
	const [press, setPress] = useState<DocxObjectPress | null>(null)
	const online = useIsOnline()
	const onAutosaveRef = useLatestRef(onAutosave)
	// The user gave the password to modify, or chose to edit a document recommended read-only, this session.
	const [writeUnlocked, setWriteUnlocked] = useState(false)
	// Write protection keeps the document view-only until then (a password gates the editor itself too).
	const writeProtection = writable && !writeUnlocked ? current?.writeProtection : undefined
	const readOnly = !writable || writeProtection !== undefined
	const pageWidth = document.pages[0]?.width ?? document.info?.pageWidth ?? 816
	const sessions = editor?.sessions
	const dirty = sessions?.some(session => session.snapshot().dirty) === true

	// A hold on autosave ends once nothing is unsaved (saved, or undone back to the saved state).
	if (autosaveHeld && !dirty) {
		setAutosaveHeld(false)
	}
	const doc = editor?.state.doc
	// The editor's layout is what the pages show; the menu's mode follows it.
	const pagesView = editor === undefined ? markupInfo(markupMode).view : editorMarkupView(editor.view)
	const shownMode = shownMarkup(markupMode, pagesView)
	// Download as ▸ PDF: the document with its unsaved edits in the Final view (markup left out, the toast says so).
	const pdf = useDocxPdfExport({
		fileName: alt,
		source: () => ({
			kind: "editor",
			live: signal => opened.editing.pdfSource(signal),
			markup: reviewing && shownMode !== "none",
			...(backend?.untranslated === undefined ? {} : { untranslated: backend.untranslated })
		}),
		encryptedFile
	})
	// Download as ▸ another format: the document as the editor holds it, unsaved edits included. A password-protected
	// one converts from its saved file, which the conversion refuses with why (an OpenDocument copy is never protected).
	const liveFile: LiveFile | undefined =
		encryptedFile === undefined ? (target, signal) => editedFile(opened.editing, target, signal, backend?.convertEdited) : undefined
	const bodyActive = editor !== undefined && editor.activeStory === editor.body.session.story.story.index
	const spellingMarks = useSyncExternalStore(
		spelling === undefined ? subscribeNothing : listener => spelling.subscribe(listener),
		spelling === undefined ? noSpelling : () => spelling.marks(),
		noSpelling
	)
	// Find runs on the document as it stands once typing pauses, never inside a keystroke (and nothing is
	// deferred while it is closed: a keystroke renders once). One match past the limit tells that there are more.
	const searchedDoc = useDeferredValue(find.open && find.query.length > 0 ? doc : undefined)
	const found =
		find.open && find.query.length > 0 && searchedDoc !== undefined
			? findInStory(searchedDoc, find.query, { caseSensitive: find.caseSensitive }, STORY_FIND_LIMIT + 1)
			: NO_MATCHES
	const capped = found.length > STORY_FIND_LIMIT
	const matches = capped ? found.slice(0, STORY_FIND_LIMIT) : found
	const active =
		matches.length === 0
			? -1
			: find.active >= 0
				? Math.min(find.active, matches.length - 1)
				: firstMatchFrom(matches, editor?.selection().from ?? 0)
	const marks = editorMarks(bodyActive ? spellingMarks : NO_SPELLING, matches, active)
	const selection = controls.state?.selection
	const viewOnly = editorViewOnlyReasons(toolbarSnapshot?.readOnlyReasons ?? [], writable, renamed)
	// Comments and tracked changes in the document: the markup menu is offered.
	const annotated = (document.info?.comments ?? 0) + (document.info?.revisions ?? 0)
	const review = toolbarSnapshot?.review
	// Comments and changes there are or can be now (tracking turned on, a comment added): the markup modes.
	const reviewing = annotated > 0 || review?.tracking === true || (review?.revisionCount ?? 0) + (review?.commentCount ?? 0) > 0
	// Margin balloons get a column right of the pages where the window has room for one; "fit" leaves it.
	const balloonsWanted =
		!reflow &&
		featureLanded("comments") &&
		(markupInfo(shownMode).comments || markupInfo(shownMode).formatting) &&
		(annotated > 0 || (review?.commentCount ?? 0) > 0)
	const aside = balloonsWanted && balloonsFit(width) ? BALLOON_COLUMN_WIDTH : 0
	const zoom = zoomMode === "fit" ? fitWidthZoom(width - aside, pageWidth, PAGE_GAP) : zoomMode
	const zoomRef = useLatestRef(zoom)

	// The editor and its spelling once the document is open for editing (proved block by block meanwhile).
	useEffect(() => {
		let live = true
		let created: DocxSpelling | undefined

		opened.editing.editor.then(
			openedEditor => {
				if (!live) {
					return
				}

				created = new DocxSpelling(openedEditor.body.session, documentSpellingChecker, {
					defaultLanguage: defaultSpellingLanguage()
				})

				const context = openedEditor.body.session.context

				openedRef.current?.()
				setReady({
					opened,
					editor: openedEditor,
					spelling: created,
					styles: offeredParagraphStyles(context),
					theme: themeSwatches(theme => context.resolver.theme?.themeColor(theme)),
					writeProtection: writeProtectionOf(context)
				})
				docxFontList(context).then(
					list => {
						if (live) {
							setFonts({ editor: openedEditor, fonts: list })
						}
					},
					(error: unknown) => {
						log.warn("docx", "font list not read", { error })
					}
				)

				const locked = opened.editing.proofLocked()

				if (locked > 0) {
					toast.info(t("previewDocxLockedBlocks", { count: locked }))
				}
			},
			// The document failed to open (the viewer shows why) or was closed.
			() => undefined
		)

		return () => {
			live = false
			created?.dispose()
		}
	}, [opened, t, openedRef])

	useEffect(() => {
		void loadOfficeSettings()
	}, [])

	// Paged layout rests while the reflowed view shows the document; it catches up from the first changed page.
	useEffect(() => {
		if (!reflow || editor === undefined) {
			return
		}

		editor.suspend()

		return () => {
			editor.resume()
		}
	}, [reflow, editor])

	// Comments and tracked changes carry the user's own author name (none until given).
	useEffect(() => {
		opened.editing.setAuthor(settings.authorName ?? undefined)
	}, [opened, settings.authorName])

	useEffect(() => {
		onDirtyChange(dirty)
	}, [dirty, onDirtyChange])

	// The overlay saves through this while the document can be saved.
	useEffect(() => {
		if (editor === undefined || !writable) {
			return
		}

		saveRef.current = docxSaveSource({
			host: opened.editing,
			editor,
			encrypted: encryption !== undefined,
			onSaved: () => {
				setAutosaveHeld(false)
			},
			onRefused: () => {
				setAutosaveHeld(true)
			},
			onSearch: searching => {
				if (searching) {
					toast.loading(t("previewDocxSaveSearching"), { id: SEARCH_TOAST })
				} else {
					toast.dismiss(SEARCH_TOAST)
				}
			},
			onNotices: notices => {
				// One kind so far: comments an ODF 1.0 or 1.1 file keeps at the start of their text.
				for (const { count } of notices) {
					toast.warning(t("previewDocxSaveCommentPoint", { count }), { duration: Infinity })
				}
			},
			onLocked: ({ count, text, reverted }) => {
				// Taken back here as saved; or not all of them (edited while the file was stored, or refused).
				const message = reverted === count ? t("previewDocxSaveLocked", { count }) : t("previewDocxSaveLockedKept", { count })

				toast.warning(message, {
					duration: Infinity,
					action: {
						label: t("previewDocxSaveLockedCopy"),
						onClick: () => {
							void writeEditorClipboard({ text })
						}
					}
				})
			}
		})

		return () => {
			saveRef.current = null
		}
	}, [editor, writable, opened, saveRef, t, encryption])

	// Idle autosave: a pause this long after the last edit saves once (selection moves are not edits), once
	// the user's setting is known (never on the default before the file was read). A document a save started
	// for is not tried again (a refused or failed save waits for the next edit); one that could not start (a
	// save in flight, a dialog open) is tried after the next pause. A refused document holds autosave until a
	// save by the user stores it.
	const autosavedRef = useRef<unknown>(null)
	const [autosaveRetry, setAutosaveRetry] = useState(0)

	useEffect(() => {
		if (
			!settings.loaded ||
			!settings.autosave ||
			E2E_AUTOSAVE_OFF ||
			autosaveHeld ||
			!dirty ||
			readOnly ||
			!online ||
			doc === undefined ||
			autosavedRef.current === doc
		) {
			return
		}

		const timer = setTimeout(() => {
			if (onAutosaveRef.current()) {
				autosavedRef.current = doc
			} else {
				setAutosaveRetry(retry => retry + 1)
			}
		}, AUTOSAVE_IDLE_MS)

		return () => {
			clearTimeout(timer)
		}
	}, [settings.loaded, settings.autosave, autosaveHeld, dirty, readOnly, online, doc, autosaveRetry, onAutosaveRef])

	// Ctrl/Cmd+wheel zooms (a native non-passive listener, as in the viewer); a plain wheel scrolls.
	useEffect(() => {
		if (wrapper === null) {
			return
		}

		const onWheel = (event: WheelEvent): void => {
			if (!event.ctrlKey && !event.metaKey) {
				return
			}

			event.preventDefault()
			setZoomMode(clampZoom(zoomRef.current - event.deltaY * WHEEL_SENSITIVITY))
		}

		wrapper.addEventListener("wheel", onWheel, { passive: false })

		return () => {
			wrapper.removeEventListener("wheel", onWheel)
		}
	}, [wrapper, zoomRef])

	// Shows the match `index` of `list`: selected, scrolled to.
	const reveal = (list: readonly StoryMatch[], index: number): void => {
		const match = list[index]

		if (editor === undefined || match === undefined) {
			return
		}

		const tr = selectMatch(editor.state, match)

		if (tr !== null) {
			editor.dispatch(tr)
			handleRef.current?.scrollToCaret()
		}
	}

	// A new search shows its first match from the caret once the results are in.
	const revealedRef = useRef<string | null>(null)

	useEffect(() => {
		const key = `${find.query}\u0000${String(find.caseSensitive)}`

		if (!find.open || active < 0 || revealedRef.current === key || editor === undefined) {
			return
		}

		revealedRef.current = key

		const match = matches[active]
		const tr = match === undefined ? null : selectMatch(editor.state, match)

		if (tr !== null) {
			editor.dispatch(tr)
			handleRef.current?.scrollToCaret()
		}
	}, [find.open, find.query, find.caseSensitive, active, matches, editor])

	const openFind = (replace: boolean): void => {
		setFind(previous =>
			previous.open
				? { ...previous, replace: previous.replace || replace, focus: previous.focus + 1 }
				: { ...FIND_CLOSED, open: true, replace }
		)
	}

	const focusEditor = (): void => {
		handleRef.current?.focus()
	}

	const runRef = useLatestRef((command: DocxEditorCommand, author?: string): void => {
		if (author !== undefined) {
			opened.editing.setAuthor(author)
		}

		// Commands that change nothing (find the next change, field codes) run while read-only too.
		if (!readOnly || !isWriteCommand(command.type)) {
			const done = controls.execute(command)

			// An async command (a field update, a picture) settles later: a failure is told.
			if (typeof done !== "boolean") {
				done.catch((error: unknown) => {
					log.error("docx", "command failed", { type: command.type, error })
					toast.error(t("previewDocxCommandFailed"))
				})
			}
		}

		focusEditor()
	})
	// A command the session refuses now asks for nothing; one that records the author asks for the name first.
	// The editor's own snapshot: a component may act right after moving the selection (a control pressed).
	const executeCommand = (command: DocxEditorCommand): void => {
		const now = editor?.snapshot()

		if (now === undefined || (readOnly && isWriteCommand(command.type)) || !now.enabled[command.type]) {
			focusEditor()

			return
		}

		if (commandNeedsAuthor(command, now.review)) {
			withAuthor(author => {
				runRef.current(command, author)
			})
		} else {
			runRef.current(command)
		}
	}

	useEffect(() => {
		executeRef.current = executeCommand
	})

	// Another markup mode: the open document is laid out again in place (its edits kept); one still opening
	// (nothing edited yet) opens again laid out for it.
	const changeMarkup = (mode: DocxMarkupMode): void => {
		if (editor === undefined) {
			if (markupInfo(mode).view !== markupInfo(markupMode).view) {
				setOpened(openEditing(bytes, mode, writeUnlocked, encryption, backend))
				setPress(null)
			}
		} else {
			const view = markupRelayout(pagesView, mode)

			if (view !== null) {
				opened.editing.setView(view)
			}
		}

		setMarkupMode(mode)
		focusEditor()
	}

	// A password lifts what the editor opened with: the document opens again unlocked (nothing was edited).
	const unlockWrite = (): void => {
		setWriteUnlocked(true)

		if (writeProtection?.password !== undefined) {
			setOpened(openEditing(bytes, markupMode, true, encryption, backend))
			setPress(null)
		}
	}

	const canReplace = !readOnly && snapshot !== undefined && !snapshot.readOnly
	const findControls: DocxFindControls = {
		query: find.query,
		caseSensitive: find.caseSensitive,
		count: matches.length,
		capped,
		active,
		search: (query, caseSensitive) => {
			revealedRef.current = null
			setFind(previous => ({ ...previous, query, caseSensitive, active: -1 }))
		},
		step: direction => {
			const next = stepMatch(active, matches.length, direction)

			setFind(previous => ({ ...previous, active: next }))
			reveal(matches, next)
		},
		close: () => {
			revealedRef.current = null
			setFind(FIND_CLOSED)
		},
		replace: {
			disabled: !canReplace,
			one: replacement => {
				const match = matches[active]

				if (editor === undefined || match === undefined) {
					return
				}

				const tr = replaceMatches(editor.state, [match], find.query, replacement, { caseSensitive: find.caseSensitive })

				if (tr === null || !editor.dispatch(tr)) {
					return
				}

				// The next match takes the replaced one's place.
				const after = findInStory(editor.state.doc, find.query, { caseSensitive: find.caseSensitive })
				const next = after.length === 0 ? -1 : firstMatchFrom(after, match.from + replacement.length)

				setFind(previous => ({ ...previous, active: next }))
				reveal(after, next)
			},
			// Every match, however many the find shows.
			all: replacement => {
				if (editor === undefined || matches.length === 0) {
					return
				}

				const result = replaceAll(editor.state, find.query, replacement, { caseSensitive: find.caseSensitive })
				const before = editor.state.doc

				if (result !== null && "tr" in result && !editor.dispatch(result.tr)) {
					return
				}

				const notice = replaceAllToast(result, editor.state.doc !== before)

				if (notice?.key === "previewDocxReplacedCount") {
					toast.success(t(notice.key, { count: notice.count }))
				} else if (notice !== undefined) {
					toast.error(t(notice.key))
				}
			}
		}
	}

	// Find opens for keys pressed in the layer the document is shown in, never for one over it; the editor's
	// own input takes Mod+F itself (onFind below).
	useAction(
		"editor.find",
		keyboardEvent => {
			const root = rootRef.current

			if (root === null || keyboardEvent.defaultPrevented) {
				return
			}

			const layer = root.closest(LAYER)
			const target = keyboardEvent.target instanceof Element ? keyboardEvent.target.closest(LAYER) : null

			if (target !== layer || (layer === null && isAnyDialogOpen())) {
				return
			}

			keyboardEvent.preventDefault()
			openFind(false)
		},
		IN_EDITORS,
		[]
	)

	// Pictures pasted, dropped or picked (Insert menu) go in through this.
	const image = useDocxImageInsert({
		host: opened.editing,
		editor,
		handleRef,
		snapshot: toolbarSnapshot,
		readOnly,
		execute,
		surface,
		...inputChannel
	})

	// A paste or drop into the review layer (a comment's field) stays there.
	const pasteAndDrop: typeof image.handlers = {
		onPasteCapture: event => {
			if (!inReview(event.target)) {
				image.handlers.onPasteCapture?.(event)
			}
		},
		onDragOverCapture: event => {
			if (!inReview(event.target)) {
				image.handlers.onDragOverCapture?.(event)
			}
		},
		onDropCapture: event => {
			if (!inReview(event.target)) {
				image.handlers.onDropCapture?.(event)
			}
		}
	}

	const shortcut = (key: string): string => (APPLE ? `⌘${key}` : `Ctrl+${key}`)

	const blocked = (key: string): void => {
		toast.error(t("previewDocxClipboardBlocked", { shortcut: shortcut(key) }))
	}

	const copy = async (): Promise<void> => {
		const content = handleRef.current?.clipboardContent()

		if (content !== undefined && !(await writeEditorClipboard(content))) {
			blocked("C")
		}

		focusEditor()
	}

	const cut = async (): Promise<void> => {
		const content = handleRef.current?.clipboardContent()

		if (content !== undefined) {
			if (await writeEditorClipboard(content)) {
				handleRef.current?.deleteSelection()
			} else {
				blocked("X")
			}
		}

		focusEditor()
	}

	// Text only: the clipboard's text, without its formatting or pictures (the ribbon's Keep text only).
	const paste = async (textOnly: boolean): Promise<void> => {
		const content = await readEditorClipboard()

		focusEditor()

		if (content === null) {
			blocked("V")
		} else if (textOnly) {
			if (content.text !== undefined && content.text !== "") {
				handleRef.current?.paste({ text: content.text })
			}
		} else if (!image.paste(content)) {
			handleRef.current?.paste(content)
		}
	}

	// The ribbon's Clipboard group: one object for the editor's life, so a keystroke re-renders no part of the ribbon.
	const clipboardRef = useLatestRef({ cut, copy, paste })
	const [ribbonClipboard] = useState<DocxRibbonClipboard>(() => ({
		cut: () => {
			void clipboardRef.current.cut()
		},
		copy: () => {
			void clipboardRef.current.copy()
		},
		paste: textOnly => {
			void clipboardRef.current.paste(textOnly)
		}
	}))

	const selectAll = (): void => {
		handleRef.current?.selectAll()
		focusEditor()
	}

	// Presses on objects go to their feature while it can change the document (the toolbar's snapshot: it
	// changes only with what that depends on).
	const interactions = objectInteractions(setPress, feature => featureEditable(toolbarSnapshot, readOnly, feature))
	const onPressDone = (): void => {
		setPress(null)
	}
	// A picker opened from the keyboard gives focus back to the document it was opened from once done.
	const keyboardPressRef = useRef(false)

	useEffect(() => {
		if (press?.pointerType === "keyboard") {
			keyboardPressRef.current = true
		} else if (press === null && keyboardPressRef.current) {
			keyboardPressRef.current = false
			handleRef.current?.focus()
		}
	}, [press])

	// Alt+Down in a dropdown or date control opens its picker at the caret, as Word does.
	const openControlPicker = (): boolean => {
		const control = toolbarSnapshot?.context.control ?? null
		const part =
			control === null
				? null
				: control.type === "dropDownList" || control.type === "comboBox"
					? "list"
					: control.type === "date"
						? "date"
						: null
		const at = handleRef.current?.selectionPoints().end
		const current = editor?.selection()

		if (part === null || at === undefined || editor === undefined || current === undefined) {
			return false
		}

		setPress({
			hit: { kind: "control", story: editor.activeStory, pos: current.from, part },
			page: -1,
			x: 0,
			y: 0,
			clientX: at.x,
			clientY: at.y,
			pointerType: "keyboard",
			pointerId: -1,
			clicks: 1,
			shiftKey: false
		})

		return true
	}
	// The pages lay out again on a keystroke and ask each mounted page for its overlay: a page whose frame and
	// inputs are as they were gets the element it got, so React draws nothing of it again.
	const overlays =
		editor === undefined || !(REVIEW_OVERLAY || OBJECT_OVERLAY)
			? undefined
			: (page: DocxPageOverlay): ReactNode => {
					const known = overlayElements.get(page.index)

					if (
						known?.page.width === page.width &&
						known.page.height === page.height &&
						known.page.zoom === page.zoom &&
						known.editor === editor &&
						known.markup === shownMode &&
						known.press === press &&
						known.readOnly === readOnly
					) {
						return known.element
					}

					const element = (
						<>
							{REVIEW_OVERLAY ? (
								<DocxReviewPageOverlay
									page={page}
									editor={editor}
									markup={shownMode}
								/>
							) : null}
							{OBJECT_OVERLAY ? (
								<DocxObjectHandles
									page={page}
									editor={editor}
									press={press}
									readOnly={readOnly}
									execute={execute}
								/>
							) : null}
						</>
					)

					overlayElements.set(page.index, { page, editor, markup: shownMode, press, readOnly, element })

					return element
				}

	// Its own element (not one with the pages'): the pages' props change as they lay out, the layer's do not.
	const reviewLayer =
		editor === undefined ? null : (
			<DocxReviewLayer
				editor={editor}
				markup={shownMode}
				zoom={zoom}
				gap={PAGE_GAP}
				container={wrapper}
				readOnly={readOnly}
				execute={execute}
				withAuthor={withAuthor}
				press={press?.hit.kind === "commentMarker" ? press : null}
				onPressDone={onPressDone}
				{...inputChannel}
			/>
		)

	// What every component acting on objects in the document gets, on either surface (once it opened).
	const objectProps =
		editor === undefined
			? null
			: {
					editor,
					snapshot: toolbarSnapshot,
					surface,
					container: wrapper,
					zoom,
					readOnly,
					execute,
					onPressDone,
					...inputChannel
				}
	const painter: DocxPainterState = editor?.painter === undefined ? "off" : editor.painter.sticky ? "sticky" : "once"
	const cancelPainter = (): void => {
		editor?.setPainter(undefined)
		focusEditor()
	}
	const header = reflow ? null : (toolbarSnapshot?.context.story.header ?? null)
	const hasSelection = selection !== undefined && !selection.empty
	const editable = !readOnly && snapshot !== undefined && !snapshot.readOnly
	const menuIssue = menu?.issue

	if (document.status === "error") {
		return viewer()
	}

	return (
		<div
			ref={rootRef}
			className="flex size-full flex-col"
			// F6 and Shift+F6 move between the ribbon and the document, as Word's panes.
			onKeyDown={event => {
				if (event.key !== "F6" || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) {
					return
				}

				const ribbon = event.currentTarget.querySelector("[data-office-ribbon]")

				if (ribbon === null) {
					return
				}

				event.preventDefault()

				if (event.target instanceof Node && ribbon.contains(event.target)) {
					focusEditor()
				} else {
					ribbonLanding(ribbon)?.focus()
				}
			}}
		>
			<DocxEditToolbar
				fileMenu={
					<DocxFileMenu
						ribbon
						onDownloadPdf={pdf.onDownloadPdf}
						liveFile={liveFile}
						autosave={{
							checked: settings.autosave,
							onChange: next => {
								saveOfficeAutosave(next).catch((error: unknown) => {
									log.warn("office", "autosave setting not saved", { error })
								})
							}
						}}
					/>
				}
				snapshot={toolbarSnapshot}
				readOnly={readOnly}
				apple={APPLE}
				execute={execute}
				clipboard={ribbonClipboard}
				viewOnly={viewOnly}
				encrypted={
					encryption === undefined
						? undefined
						: {
								integrity: encryptionIntegrity ?? "unchecked",
								// Saves keep the password only while the session can save (not read-only, nor write-protected).
								saving: writable && writeProtection === undefined && toolbarSnapshot?.readOnly !== true
							}
				}
				find={{ open: find.open, replace: find.replace, focus: find.focus, controls: findControls }}
				onFindOpen={openFind}
				onFindClosed={focusEditor}
				markup={reviewing ? shownMode : null}
				onMarkupChange={changeMarkup}
				zoom={zoom}
				onZoom={change => {
					setZoomMode(change === "fit" ? "fit" : stepZoom(zoom, change === "in" ? 1 : -1))
				}}
				reflow={reflow}
				onReflowChange={setReflow}
				surface={surface}
				styles={current?.styles ?? DOCX_PARAGRAPH_STYLES}
				fonts={fonts !== null && fonts.editor === editor ? fonts.fonts : NO_FONTS}
				theme={current?.theme ?? []}
				painter={painter}
				onPainterCancel={cancelPainter}
				fieldCodes={editor?.fieldCodes === true}
				{...inputChannel}
			/>
			{writeProtection === undefined ? null : (
				<DocxWriteProtectionBar
					protection={writeProtection}
					name={alt}
					onUnlock={unlockWrite}
				/>
			)}
			{autosaveHeld && settings.autosave ? (
				<p
					role="status"
					className="shrink-0 border-b bg-muted px-3 py-1.5 text-xs text-muted-foreground"
				>
					{t("previewDocxAutosaveHeld", { shortcut: shortcut("S") })}
				</p>
			) : null}
			<ContextMenu
				onOpenChange={open => {
					if (!open) {
						focusEditor()
					}
				}}
			>
				<ContextMenuTrigger
					ref={setWrapper}
					data-preview-surface
					className="relative min-h-0 flex-1 select-auto"
					onKeyDownCapture={event => {
						if (
							event.key === "ArrowDown" &&
							event.altKey &&
							!event.ctrlKey &&
							!event.metaKey &&
							!event.shiftKey &&
							!inReview(event.target) &&
							openControlPicker()
						) {
							event.preventDefault()
							event.stopPropagation()
						}
					}}
					onPointerDownCapture={event => {
						setTouch(event.pointerType === "touch" || event.pointerType === "pen")
					}}
					// The format painter paints the selection a press in the document made (Word's).
					onPointerUp={event => {
						// The primary button's release only: a right click opens the context menu, it paints nothing.
						if (
							painter !== "off" &&
							event.isPrimary &&
							event.button === 0 &&
							press === null &&
							event.target instanceof Node &&
							wrapper?.contains(event.target) === true
						) {
							execute({ type: "format.paste" })
						}
					}}
					// Touch gets the touch menu (below), not this menu's long press.
					onTouchStartCapture={event => {
						event.stopPropagation()
					}}
					{...pasteAndDrop}
					onContextMenuCapture={event => {
						// The review layer's balloons and fields keep the browser's own menu (spelling in a comment).
						if (inReview(event.target)) {
							event.stopPropagation()

							return
						}

						const handle = handleRef.current

						if (touch || handle === null || editor === undefined) {
							event.preventDefault()
							event.stopPropagation()

							return
						}

						const hit = handle.hitTest(event.clientX, event.clientY)
						const current = editor.selection()

						// A press outside the selection moves the caret there first, as in Word.
						if (hit !== undefined && (hit.pos < current.from || hit.pos > current.to)) {
							editor.select(hit)
						}

						const pos = hit?.pos ?? current.head
						const issue = bodyActive && spelling !== undefined ? spelling.spellingAt(pos) : undefined

						setMenu({ pos, issue, suggestions: issue?.kind === "spelling" ? undefined : [] })

						if (issue?.kind === "spelling" && spelling !== undefined) {
							spelling
								.suggestions(pos)
								.then(found => {
									setMenu(previous =>
										previous?.pos === pos ? { ...previous, suggestions: found.slice(0, MAX_SUGGESTIONS) } : previous
									)
								})
								.catch(() => {
									setMenu(previous => (previous?.pos === pos ? { ...previous, suggestions: [] } : previous))
								})
						}
					}}
				>
					{describedBy === undefined ? null : (
						<span
							id={describedBy}
							className="sr-only"
						>
							{t("previewDocxEditorKeys")}
						</span>
					)}
					{editor === undefined ? null : reflow ? (
						<DocxReflowSurface
							editor={editor}
							document={document}
							handleRef={handleRef}
							label={alt}
							{...(describedBy === undefined ? {} : { describedBy })}
							readOnly={readOnly}
							apple={APPLE}
							marks={marks}
							onFind={() => {
								openFind(false)
							}}
							{...(interactions === undefined ? {} : { interactions })}
						/>
					) : (
						<>
							<DocxEditor
								ref={handleRef}
								editor={editor}
								document={document}
								zoom={zoom}
								gap={PAGE_GAP}
								className="size-full"
								label={alt}
								{...(describedBy === undefined ? {} : { describedBy })}
								readOnly={readOnly}
								apple={APPLE}
								onFind={() => {
									openFind(false)
								}}
								marks={marks}
								aside={aside}
								{...(interactions === undefined ? {} : { interactions })}
								{...(overlays === undefined ? {} : { overlays })}
							/>
							{reviewLayer}
							<DocxLayoutBusy busy={document.status === "streaming"} />
						</>
					)}
					{editor === undefined || reflow ? null : (
						<DocxTableBorderDrag
							editor={editor}
							press={press?.hit.kind === "tableBorder" ? press : null}
							onPressDone={onPressDone}
							container={wrapper}
							zoom={zoom}
							readOnly={readOnly}
							execute={execute}
						/>
					)}
					{header === null || toolbarSnapshot === undefined ? null : (
						<DocxHeaderChip
							header={header}
							enabled={toolbarSnapshot.enabled}
							readOnly={readOnly}
							execute={execute}
							onClose={() => {
								editor?.exitStory()
								focusEditor()
							}}
						/>
					)}
					{objectProps === null ? null : (
						<>
							<DocxFormControls
								{...objectProps}
								press={press?.hit.kind === "control" ? press : null}
							/>
							<DocxEquationPopover
								{...objectProps}
								press={press?.hit.kind === "equation" ? press : null}
							/>
							<DocxFieldChip
								{...objectProps}
								press={press?.hit.kind === "field" || press?.hit.kind === "noteRef" ? press : null}
							/>
							<DocxDrawingPress
								{...objectProps}
								press={press?.hit.kind === "drawing" ? press : null}
							/>
							<DocxCommentPopover
								{...objectProps}
								withAuthor={withAuthor}
								press={press?.hit.kind === "commentMarker" ? press : null}
							/>
						</>
					)}
					<DocxTouchSelection
						handleRef={handleRef}
						container={wrapper}
						shown={touch && hasSelection && !reflow}
						selectionKey={
							selection === undefined || !touch ? "" : `${String(selection.anchor)}:${String(selection.head)}:${String(zoom)}`
						}
						actions={{
							cut: editable
								? () => {
										void cut()
									}
								: null,
							copy: () => {
								void copy()
							},
							paste: editable
								? () => {
										void paste(false)
									}
								: null,
							selectAll
						}}
					/>
					{/* The pages' layout rests while Mobile view shows the document: it waits for the editor only. */}
					{editor === undefined || (!reflow && document.status === "loading") ? (
						<LoadingState
							size="lg"
							className="absolute inset-0 text-inherit"
						/>
					) : null}
				</ContextMenuTrigger>
				<ContextMenuContent data-preview-surface>
					{menuIssue?.kind === "spelling" && spelling !== undefined && menu !== null ? (
						<>
							{menu.suggestions === undefined ? (
								<ContextMenuItem disabled>{t("previewDocxSpellingLoading")}</ContextMenuItem>
							) : menu.suggestions.length === 0 ? (
								<ContextMenuItem disabled>{t("previewDocxSpellingNone")}</ContextMenuItem>
							) : (
								menu.suggestions.map(suggestion => (
									<ContextMenuItem
										key={suggestion}
										className="font-medium"
										disabled={!editable}
										onClick={() => {
											spelling.replaceWord(menu.pos, suggestion)
										}}
									>
										{suggestion}
									</ContextMenuItem>
								))
							)}
							<ContextMenuItem
								onClick={() => {
									spelling.ignoreAll(menu.pos)
								}}
							>
								{t("previewDocxSpellingIgnoreAll")}
							</ContextMenuItem>
							<ContextMenuItem
								onClick={() => {
									void spelling.addToDictionary(menu.pos)
								}}
							>
								{t("previewDocxSpellingAdd")}
							</ContextMenuItem>
							<ContextMenuSeparator />
						</>
					) : null}
					{menuIssue?.kind === "repeated" && spelling !== undefined && menu !== null ? (
						<>
							<ContextMenuItem
								disabled={!editable}
								onClick={() => {
									spelling.replaceWord(menu.pos, "")
								}}
							>
								{t("previewDocxSpellingDeleteRepeated")}
							</ContextMenuItem>
							<ContextMenuItem
								onClick={() => {
									spelling.ignoreAll(menu.pos)
								}}
							>
								{t("previewDocxSpellingIgnoreRepeated")}
							</ContextMenuItem>
							<ContextMenuSeparator />
						</>
					) : null}
					<ContextMenuItem
						disabled={!hasSelection || !editable}
						onClick={() => {
							void cut()
						}}
					>
						{t("previewDocxCut")}
					</ContextMenuItem>
					<ContextMenuItem
						disabled={!hasSelection}
						onClick={() => {
							void copy()
						}}
					>
						{t("previewDocxCopy")}
					</ContextMenuItem>
					<ContextMenuItem
						disabled={!editable}
						onClick={() => {
							void paste(false)
						}}
					>
						{t("previewDocxPaste")}
					</ContextMenuItem>
					<ContextMenuSeparator />
					<ContextMenuItem onClick={selectAll}>{t("previewDocxSelectAll")}</ContextMenuItem>
					<DocxContextCommands
						snapshot={toolbarSnapshot}
						readOnly={readOnly}
						execute={execute}
						requestInput={requestInput}
						surface={surface}
					/>
				</ContextMenuContent>
			</ContextMenu>
			{authorDialog}
			{pdf.prompt}
			{image.dialogs}
			{editor === undefined ? null : (
				<DocxPageSetupDialog
					editor={editor}
					readOnly={readOnly}
					enabled={toolbarSnapshot?.enabled["page.setup"] === true}
					{...inputChannel}
				/>
			)}
			<DocxParagraphDialog
				values={toolbarSnapshot?.values}
				execute={execute}
				{...inputChannel}
			/>
			{editor === undefined ? null : (
				<DocxTableSplitDialog
					editor={editor}
					readOnly={readOnly}
					{...inputChannel}
				/>
			)}
		</div>
	)
}
