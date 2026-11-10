// "preview" namespace, presentation editor ribbon: the tabs only presentations have, and the Home, Insert and View
// tabs' slide commands. Home, Insert, Review and View themselves are previewOfficeRibbonTab*. Spread into preview.ts;
// same catalog rules.
export const previewPptxRibbon = {
	/** Presentation editor — ribbon tab: themes, variants, slide size and background */
	previewPptxRibbonTabDesign: "Design",
	/** Presentation editor — ribbon tab: the effect when one slide moves to the next in the slide show */
	previewPptxRibbonTabTransitions: "Transitions",
	/** Presentation editor — ribbon tab: animation effects on the objects of a slide */
	previewPptxRibbonTabAnimations: "Animations",
	/** Presentation editor — ribbon tab: starting and setting up the slide show */
	previewPptxRibbonTabSlideShow: "Slide Show",
	/** Presentation editor — ribbon tab: order, grouping and alignment of the objects on a slide */
	previewPptxRibbonTabArrange: "Arrange",
	/** Presentation editor — contextual ribbon tab while a shape or text box is selected */
	previewPptxRibbonTabShapeFormat: "Shape Format",
	/** Presentation editor — contextual ribbon tab while a picture is selected */
	previewPptxRibbonTabPicture: "Picture",
	/** Presentation editor — contextual ribbon tab while a table is selected */
	previewPptxRibbonTabTable: "Table",
	/** Presentation editor — contextual ribbon tab while a chart is selected */
	previewPptxRibbonTabChart: "Chart",
	/** Presentation editor — contextual ribbon tab while a video is selected */
	previewPptxRibbonTabVideo: "Video",
	/** Presentation editor — contextual ribbon tab while an audio clip is selected */
	previewPptxRibbonTabAudio: "Audio",
	/** Presentation editor — contextual ribbon tab while a SmartArt graphic is selected: its layout, colours and style */
	previewPptxRibbonTabSmartArtDesign: "SmartArt Design",
	/** Presentation editor — contextual ribbon tab while a SmartArt graphic is selected: its shapes' fill and outline */
	previewPptxRibbonTabSmartArtFormat: "Format",
	/** Presentation editor — ribbon button: undoes the last change */
	previewPptxRibbonUndo: "Undo",
	/** Presentation editor — ribbon button: does again the change last undone */
	previewPptxRibbonRedo: "Redo",
	/** Presentation editor — ribbon group of the slide commands (new, layout, reset, section, duplicate, delete, hide) */
	previewPptxRibbonSlides: "Slides",
	/** Presentation editor — ribbon button: adds a slide after the current one, on the layout PowerPoint would pick */
	previewPptxRibbonNewSlide: "New slide",
	/** Presentation editor — accessible label of the menu next to New slide: a new slide on a layout chosen from the list */
	previewPptxRibbonNewSlideLayout: "New slide with layout",
	/** Presentation editor — ribbon menu: the layout of the selected slides */
	previewPptxRibbonLayout: "Layout",
	/** Presentation editor — a layout in the Layout menus when the file gives it no name; {{number}} counts from 1 */
	previewPptxRibbonLayoutNumber: "Layout {{number}}",
	/** Presentation editor — a Title Slide layout in the Layout menus when the file gives it no name */
	previewPptxRibbonLayoutTitle: "Title Slide",
	/** Presentation editor — a Title and Content layout in the Layout menus when the file gives it no name */
	previewPptxRibbonLayoutObj: "Title and Content",
	/** Presentation editor — a Section Header layout in the Layout menus when the file gives it no name */
	previewPptxRibbonLayoutSecHead: "Section Header",
	/** Presentation editor — a Two Content layout in the Layout menus when the file gives it no name */
	previewPptxRibbonLayoutTwoObj: "Two Content",
	/** Presentation editor — a Comparison layout in the Layout menus when the file gives it no name */
	previewPptxRibbonLayoutTwoTxTwoObj: "Comparison",
	/** Presentation editor — a Title Only layout in the Layout menus when the file gives it no name */
	previewPptxRibbonLayoutTitleOnly: "Title Only",
	/** Presentation editor — a Blank layout in the Layout menus when the file gives it no name */
	previewPptxRibbonLayoutBlank: "Blank",
	/** Presentation editor — a Content with Caption layout in the Layout menus when the file gives it no name */
	previewPptxRibbonLayoutObjTx: "Content with Caption",
	/** Presentation editor — a Picture with Caption layout in the Layout menus when the file gives it no name */
	previewPptxRibbonLayoutPicTx: "Picture with Caption",
	/** Presentation editor — a Title and Vertical Text layout in the Layout menus when the file gives it no name */
	previewPptxRibbonLayoutVertTx: "Title and Vertical Text",
	/** Presentation editor — a Vertical Title and Text layout in the Layout menus when the file gives it no name */
	previewPptxRibbonLayoutVertTitleAndTx: "Vertical Title and Text",
	/** Presentation editor — heading of one slide master's layouts in the Layout menus when the deck has several masters; {{number}} counts from 1 */
	previewPptxRibbonMasterNumber: "Slide master {{number}}",
	/** Presentation editor — ribbon button: puts the placeholders of the selected slides back where their layout has them, with its formatting */
	previewPptxRibbonReset: "Reset",
	/** Presentation editor — ribbon menu of the deck's sections (add, rename, remove) */
	previewPptxRibbonSection: "Section",
	/** Presentation editor — ribbon button: a copy of the selected slides after them */
	previewPptxRibbonDuplicate: "Duplicate slide",
	/** Presentation editor — ribbon button: deletes the selected slides */
	previewPptxRibbonDelete: "Delete slide",
	/** Presentation editor — ribbon toggle: hides the selected slides in the slide show (they stay in the file) */
	previewPptxRibbonHide: "Hide slide",
	/** Presentation editor — ribbon group on the View tab: the slide list and the notes pane */
	previewPptxRibbonPanes: "Show",
	/** Presentation editor — ribbon button at the end of the tab row: starts the slide show from the current slide */
	previewPptxRibbonPresent: "Present",
	/** Presentation editor — View tab ▸ Zoom: fits the whole slide in the window again (PowerPoint's Fit to Window) */
	previewPptxRibbonFitToWindow: "Fit to Window",
	/** Presentation viewer — short text of the command bar's zoom button that fits the whole slide in the window again; its tooltip is "Fit to Window" */
	previewPptxZoomFitShort: "Fit",
	/** Shortcuts list — zooms the slide in, in the presentation editor */
	previewPptxEditorKeyZoomIn: "Zoom in (presentations)",
	/** Shortcuts list — zooms the slide out, in the presentation editor */
	previewPptxEditorKeyZoomOut: "Zoom out (presentations)",
	/** Shortcuts list — fits the whole slide in the window, in the presentation editor */
	previewPptxEditorKeyZoomFit: "Zoom to fit (presentations)",
	/** Shortcuts list — copies the formatting of the selected text or text shapes, in the presentation editor */
	previewPptxEditorKeyCopyFormat: "Copy formatting (presentations)",
	/** Shortcuts list — applies the copied formatting to the selected text or text shapes, in the presentation editor */
	previewPptxEditorKeyPasteFormat: "Paste formatting (presentations)"
}
