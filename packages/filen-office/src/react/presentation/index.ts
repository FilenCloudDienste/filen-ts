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
	type ShowScreen,
	type ShowStart
} from "./show/controller"
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
export { StaticShow, type StaticShowProps } from "./show/static"
export { paintSlide } from "./paint/slide"
