// "preview" namespace, presentations: the Animations tab's custom motion paths (Draw Custom Path, Edit Points and the
// path's options) and the motion-path layer on the slide. Spread into preview.ts; same catalog rules.
export const previewPptxMotionPaths = {
	/** Presentation editor, Animations tab — group of the custom motion path commands */
	previewPptxMotionGroup: "Motion Paths",
	/** Presentation editor, Animations tab — menu of tools that draw a custom motion path for the selected object */
	previewPptxMotionDraw: "Custom Path",
	/** Presentation editor, Animations tab, Custom Path menu — tool: a straight line from where you press to where you release */
	previewPptxMotionToolLine: "Line",
	/** Presentation editor, Animations tab, Custom Path menu — tool: a smooth curve through the points you click */
	previewPptxMotionToolCurve: "Curve",
	/** Presentation editor, Animations tab, Custom Path menu — tool: straight segments where you click, freehand where you drag */
	previewPptxMotionToolFreeform: "Freeform",
	/** Presentation editor, Animations tab, Custom Path menu — tool: a freehand path drawn while you drag */
	previewPptxMotionToolScribble: "Scribble",
	/** Presentation editor, Animations tab, Custom Path menu — how to finish the curve and freeform tools */
	previewPptxMotionDrawHint: "Double-click or press Enter to finish; click the start to close the path; Esc cancels.",
	/** Presentation editor, Animations tab — turns on editing of the selected motion path's points */
	previewPptxMotionEditPoints: "Edit Points",
	/** Presentation editor, Animations tab — makes the selected motion path run the other way */
	previewPptxMotionReverse: "Reverse Path Direction",
	/** Presentation editor, Animations tab — menu of the path's options (open or closed, locked or unlocked) */
	previewPptxMotionPathOptions: "Path",
	/** Presentation editor, Animations tab, Path menu — joins the path's end to its start */
	previewPptxMotionClose: "Close Path",
	/** Presentation editor, Animations tab, Path menu — removes the segment that joins the path's end to its start */
	previewPptxMotionOpen: "Open Path",
	/** Presentation editor, Animations tab, Path menu — the path stays where it is when its object moves */
	previewPptxMotionLocked: "Locked",
	/** Presentation editor, Animations tab, Path menu — the path moves with its object */
	previewPptxMotionUnlocked: "Unlocked",
	/** Presentation editor, Animations tab — menu of the selected point's type and the segment after it, while editing points */
	previewPptxMotionPointMenu: "Point",
	/** Presentation editor, Animations tab, Point menu — section title: the selected point's type */
	previewPptxMotionPointType: "Point type",
	/** Presentation editor, Animations tab, Point menu — point type: its curves follow the points around it */
	previewPptxMotionPointAuto: "Auto Point",
	/** Presentation editor, Animations tab, Point menu — point type: its two handles stay in a line and equally long */
	previewPptxMotionPointSmooth: "Smooth Point",
	/** Presentation editor, Animations tab, Point menu — point type: its two handles stay in a line, each its own length */
	previewPptxMotionPointStraight: "Straight Point",
	/** Presentation editor, Animations tab, Point menu — point type: its two handles move independently */
	previewPptxMotionPointCorner: "Corner Point",
	/** Presentation editor, Animations tab, Point menu — section title: the segment after the selected point */
	previewPptxMotionSegment: "Segment",
	/** Presentation editor, Animations tab, Point menu — makes the segment after the point straight */
	previewPptxMotionSegmentStraight: "Straight Segment",
	/** Presentation editor, Animations tab, Point menu — makes the segment after the point curved */
	previewPptxMotionSegmentCurved: "Curved Segment",
	/** Presentation editor, Animations tab, Point menu — removes the selected point from the path */
	previewPptxMotionDeletePoint: "Delete Point",
	/** Presentation editor, slide — accessible name of the slide while a custom motion path is being drawn */
	previewPptxMotionDrawing:
		"Drawing a motion path. Click to add points, or move with the arrow keys and press Space to add one; Enter finishes, Escape cancels.",
	/** Presentation editor, slide — accessible name of the slide while a motion path's points are edited */
	previewPptxMotionEditing:
		"Editing motion path points. Tab moves between points, arrow keys move the point, Delete removes it, Escape ends.",
	/** Presentation editor, slide — announced when a point of a motion path is selected */
	previewPptxMotionPointOf: "Point {{index}} of {{count}}",
	/** Presentation editor, Animation Pane — name of an effect that moves an object along a path the user drew */
	previewPptxMotionCustomPath: "Custom Path",
	/** Presentation editor, Animations tab — shown when a custom path can't be added (nothing or several objects selected) */
	previewPptxMotionSelectOne: "Select one object to draw its path.",
	/** Presentation editor, Animations tab — shown when the selected motion path can't be edited point by point */
	previewPptxMotionNotEditable: "This path can't be edited point by point.",
	/** Presentation editor, Animations tab — shown when the selected motion path has more points than can be edited */
	previewPptxMotionTooManyPoints: "This path has too many points to edit point by point."
}
