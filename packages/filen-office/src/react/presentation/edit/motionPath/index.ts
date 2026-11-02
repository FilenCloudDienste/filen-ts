// Custom motion paths on the editor's canvas: the layer, the drawing tools and the slide's paths as it shows them,
// with the path model's edits the ribbon applies (core/anim/motionEdit.ts).
export { MotionPathLayer, type MotionPathLabels, type MotionPathLayerProps, type MotionPathView } from "./MotionPathLayer"
export { MOTION_TOOLS, PathDrawing, type MotionTool } from "./draw"
export { editablePath, isCustomPath, motionPathViews } from "./views"
export {
	CUSTOM_PATH_ID,
	customPathPreset,
	deletePoint,
	kindOf,
	motionBehaviors,
	readEditablePath,
	reversePath,
	segmentCount,
	setClosed,
	setPointKind,
	setSegmentType,
	writeEditablePath,
	type EditablePath,
	type MotionBehavior,
	type PointKind
} from "../../../../core/anim/motionEdit"
