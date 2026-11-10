export {
	unavailablePresenterPortal,
	unavailableShowController,
	type PresenterOpen,
	type PresenterPortal,
	type PresenterWindowLike,
	type ShowController,
	type ShowEvent,
	type ShowEventType,
	type ShowFrom,
	type ShowMirror,
	type ShowScreen,
	type ShowStart
} from "./show/controller"
export { ShowMirrorLink } from "./show/mirror"
export { ShowMirrorView, type ShowMirrorViewProps } from "./show/mirrorView"
export { SlideView, type PaintedSlide, type SlidePaintContext, type SlidePainter, type SlideViewProps } from "./SlideView"
export {
	createPresentationStore,
	IDLE_PRESENTATION,
	usePresentationDocument,
	type PresentationConnection,
	type PresentationDocument,
	type PresentationHost,
	type PresentationStatus,
	type PresentationStore,
	type PresentationStoreOptions,
	type PresentationThumb
} from "./store"
export {
	isPresentationUrl,
	presentationActions,
	PRESENTATION_URL_SCHEMES,
	type ActionOutcome,
	type ActionTrigger,
	type PresentationActionActivator,
	type PresentationActionPolicy,
	type PresentationJump,
	type PresentationMediaRequest
} from "./links"
export { SlideRail, type SlideRailProps } from "./rail/SlideRail"
export { NotesPanel, type NotesPanelProps } from "./notes/NotesPanel"
export { NotesText } from "./notes/NotesText"
export { paintEditorSlide, paintSlide } from "./paint/slide"
export {
	boundsOf,
	clickTarget,
	createShapeSelection,
	groupMembers,
	hitPath,
	ownXfrm,
	placements,
	selectedShapes,
	selectionGroup,
	selectionKinds,
	shapeOf,
	siblingShapes,
	slideShapes,
	useShapeSelection,
	type Bounds,
	type ClickTarget,
	type SelectionKind,
	type ShapeSelection,
	type ShapeSelectionState,
	type SlideShape
} from "./edit/selection"
export { ShapeEditLayer, HANDLES_LIMIT, type ShapeEditLabels, type ShapeEditLayerProps } from "./edit/overlay"
export * from "./edit/motionPath/index"
export { OBJECT_COMMANDS, type ObjectCommand, type ObjectKeyBindings } from "./edit/keyboard"
export { PresentationTextEditor, type PresentationTextEditorProps, type TextEditorLabels } from "./edit/text/TextEditor"
export { TextEditController, COMMIT_IDLE_MS, type TextEditFormat } from "./edit/text/controller"
export { createTextEditing, formatShapes, useTextEditing, type TextEditing } from "./edit/text/editing"
export { formatPainterOf, useFormatPainter, type FormatPainter, type FormatPainterHost, type FormatPainterMode } from "./edit/text/painter"
export {
	APPLE_TEXT_BINDINGS,
	DEFAULT_TEXT_BINDINGS,
	defaultTextBindings,
	textKeyCommand,
	type TextKeyBindings,
	type TextKeyCommand
} from "./edit/text/keys"
export { cellNavigation, cellStep, firstPlaceholder, placeholderNavigation, type CellMove, type TextNavigation } from "./edit/text/navigate"
export { SlideShow, type ShowBarState, type SlideShowProps } from "./show/player"
export { changePointer, type PointerChange } from "./show/pointer"
export { type ShowMediaEvents, type ShowMediaHandle, type ShowMediaMount } from "./show/stage"
export { DEFAULT_SHOW_OPTIONS, showOptionsOf, type ShowOptions } from "./show/timeline"
export {
	showMediaMount,
	type MediaCommand,
	type MediaRemux,
	type ShowMediaLabels,
	type ShowMediaOptions,
	type ShowMediaStatus,
	type ShowMediaStreams
} from "./show/media"
export { knownMediaDuration, noteMediaDuration } from "./show/mediaTiming"
export * from "./presenter/index"
export * from "./ink/index"
