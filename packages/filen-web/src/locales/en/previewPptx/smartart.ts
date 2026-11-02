// "preview" namespace, presentation editor: SmartArt graphics: Insert ▸ SmartArt and its gallery, the SmartArt Design
// and Format tabs, and the text pane beside the slide. Our own gallery's names too. Spread into preview.ts; same
// catalog rules.
export const previewPptxSmartArt = {
	/** Presentation editor — Insert ribbon: the SmartArt group's name and its button */
	previewPptxSmartArtGroup: "SmartArt",
	/** Presentation editor — Insert ribbon: tooltip of the button that opens the SmartArt gallery */
	previewPptxSmartArtInsert: "Insert a SmartArt graphic",
	/** Presentation editor — Insert ribbon: why the SmartArt button is off in a presentation that is not a PowerPoint (.pptx) file */
	previewPptxSmartArtUnavailableFormat: "SmartArt graphics can only be inserted in PowerPoint (.pptx) presentations",
	/** Presentation editor — SmartArt gallery dialog: title */
	previewPptxSmartArtGalleryTitle: "Choose a SmartArt graphic",
	/** Presentation editor — SmartArt gallery dialog: description under the title */
	previewPptxSmartArtGalleryDescription: "Pick a layout. You can type its text in the text pane once it is on the slide.",
	/** Presentation editor — SmartArt gallery dialog: label of the category picker */
	previewPptxSmartArtGalleryCategory: "Category",
	/** Presentation editor — SmartArt gallery dialog: accessible name of the grid of layouts */
	previewPptxSmartArtGalleryLayouts: "Layouts",
	/** Presentation editor — SmartArt gallery dialog: shown when the chosen category has no layouts */
	previewPptxSmartArtGalleryEmpty: "No layouts in this category",
	/** Presentation editor — SmartArt gallery dialog: the button that puts the chosen graphic on the slide */
	previewPptxSmartArtGalleryInsert: "Insert",
	/** Presentation editor — SmartArt dialogs: cancel button */
	previewPptxSmartArtCancel: "Cancel",
	/** Presentation editor — SmartArt gallery category: every layout */
	previewPptxSmartArtCategoryAll: "All",
	/** Presentation editor — SmartArt gallery category: lists of items */
	previewPptxSmartArtCategoryList: "List",
	/** Presentation editor — SmartArt gallery category: steps of a process */
	previewPptxSmartArtCategoryProcess: "Process",
	/** Presentation editor — SmartArt gallery category: steps that repeat in a cycle */
	previewPptxSmartArtCategoryCycle: "Cycle",
	/** Presentation editor — SmartArt gallery category: organization charts and trees */
	previewPptxSmartArtCategoryHierarchy: "Hierarchy",
	/** Presentation editor — SmartArt gallery category: how ideas connect */
	previewPptxSmartArtCategoryRelationship: "Relationship",
	/** Presentation editor — SmartArt gallery category: parts of a whole in a grid */
	previewPptxSmartArtCategoryMatrix: "Matrix",
	/** Presentation editor — SmartArt gallery category: proportional or layered relationships */
	previewPptxSmartArtCategoryPyramid: "Pyramid",
	/** Presentation editor — SmartArt gallery category: layouts with pictures */
	previewPptxSmartArtCategoryPicture: "Picture",
	/** Presentation editor — the name a newly inserted SmartArt graphic gets (shown in the file's selection pane) */
	previewPptxSmartArtDefaultName: "Diagram",
	/** Presentation editor — our own SmartArt layout: blocks side by side in a row */
	previewPptxSmartArtLayoutRow: "Row of blocks",
	/** Presentation editor — our own SmartArt layout: blocks stacked in a column */
	previewPptxSmartArtLayoutColumn: "Column of blocks",
	/** Presentation editor — our own SmartArt style: shapes without effects */
	previewPptxSmartArtStyleFlat: "Flat",
	/** Presentation editor — our own SmartArt colors: the theme's accent color */
	previewPptxSmartArtColorsAccent: "Accent color",
	/** Presentation editor — SmartArt menus: heading over the layouts, styles or colors that the open file brings with it */
	previewPptxSmartArtFromFile: "In this file",
	/** Presentation editor — SmartArt menus: a definition the file brings without a name; {{id}} is its identifier */
	previewPptxSmartArtUntitled: "Untitled ({{id}})",
	/** Presentation editor — SmartArt Design ribbon: group that adds, moves and indents the graphic's shapes */
	previewPptxSmartArtCreateGraphic: "Create graphic",
	/** Presentation editor — SmartArt Design ribbon: menu that adds a shape to the graphic */
	previewPptxSmartArtAddShape: "Add shape",
	/** Presentation editor — SmartArt Design ribbon, Add shape menu: a new shape after the chosen one, on its level */
	previewPptxSmartArtAddAfter: "Add shape after",
	/** Presentation editor — SmartArt Design ribbon, Add shape menu: a new shape before the chosen one, on its level */
	previewPptxSmartArtAddBefore: "Add shape before",
	/** Presentation editor — SmartArt Design ribbon, Add shape menu: a new shape one level up, over the chosen one */
	previewPptxSmartArtAddAbove: "Add shape above",
	/** Presentation editor — SmartArt Design ribbon, Add shape menu: a new shape one level down, under the chosen one */
	previewPptxSmartArtAddBelow: "Add shape below",
	/** Presentation editor — SmartArt Design ribbon: moves the chosen shape one level up (outdent) */
	previewPptxSmartArtPromote: "Promote",
	/** Presentation editor — SmartArt Design ribbon: moves the chosen shape one level down (indent) */
	previewPptxSmartArtDemote: "Demote",
	/** Presentation editor — SmartArt Design ribbon: moves the chosen shape before the one above it */
	previewPptxSmartArtMoveUp: "Move up",
	/** Presentation editor — SmartArt Design ribbon: moves the chosen shape after the one below it */
	previewPptxSmartArtMoveDown: "Move down",
	/** Presentation editor — SmartArt Design ribbon: shows or hides the text pane beside the slide */
	previewPptxSmartArtTextPane: "Text pane",
	/** Presentation editor — SmartArt Design ribbon: group that switches the graphic's layout */
	previewPptxSmartArtLayouts: "Layouts",
	/** Presentation editor — SmartArt Design ribbon: menu of layouts */
	previewPptxSmartArtChangeLayout: "Change layout",
	/** Presentation editor — SmartArt Design ribbon: group of the graphic's style and colors */
	previewPptxSmartArtStyles: "SmartArt styles",
	/** Presentation editor — SmartArt Design ribbon: menu of styles */
	previewPptxSmartArtChangeStyle: "Style",
	/** Presentation editor — SmartArt Design ribbon: menu of color sets */
	previewPptxSmartArtChangeColors: "Change colors",
	/** Presentation editor — SmartArt Format ribbon: group with the graphic's height and width */
	previewPptxSmartArtSize: "Size",
	/** Presentation editor — SmartArt Format ribbon: height of the graphic; {{unit}} is "cm" or "in" */
	previewPptxSmartArtHeight: "Height ({{unit}})",
	/** Presentation editor — SmartArt Format ribbon: width of the graphic; {{unit}} is "cm" or "in" */
	previewPptxSmartArtWidth: "Width ({{unit}})",
	/** Presentation editor — text pane: accessible name of the pane beside the slide */
	previewPptxSmartArtTextPaneLabel: "SmartArt text pane",
	/** Presentation editor — text pane: heading */
	previewPptxSmartArtTextPaneTitle: "Type your text here",
	/** Presentation editor — text pane: button that closes it */
	previewPptxSmartArtTextPaneClose: "Close the text pane",
	/** Presentation editor — text pane: accessible description of its keys */
	previewPptxSmartArtTextPaneKeys:
		"Enter adds a shape after this one, Shift+Enter starts a new line. Tab demotes the shape, Shift+Tab promotes it, Alt+Shift+Up and Alt+Shift+Down move it. Backspace in an empty shape removes it. Escape leaves the text pane.",
	/** Presentation editor — text pane: accessible name of one shape's text field; {{number}} counts from the top, {{level}} is its indent (1 = top) */
	previewPptxSmartArtNodeLabel: "Shape {{number}}, level {{level}}",
	/** Presentation editor — text pane: accessible name of an assistant shape's text field (organization charts) */
	previewPptxSmartArtAssistantLabel: "Assistant shape {{number}}, level {{level}}",
	/** Presentation editor — text pane: placeholder in a shape without text */
	previewPptxSmartArtNodePlaceholder: "[Text]",
	/** Presentation editor — text pane: shown while the graphic's shapes are read */
	previewPptxSmartArtTextPaneLoading: "Reading the graphic…",
	/** Presentation editor — text pane: shown when the graphic could not be read */
	previewPptxSmartArtTextPaneFailed: "This graphic's text cannot be edited here",
	/** Presentation editor — text pane: shown when the graphic has no shapes */
	previewPptxSmartArtTextPaneEmpty: "This graphic has no shapes yet.",
	/** Presentation editor — text pane: button that adds the first shape to an empty graphic */
	previewPptxSmartArtTextPaneAddFirst: "Add a shape",
	/** Presentation editor — on the slide: the prompt in an empty picture placeholder of a SmartArt graphic; clicking it picks a picture from this device */
	previewPptxSmartArtPicturePrompt: "Insert a picture",
	/** Presentation editor — text pane: button beside item {{number}} that puts a picture from this device into its empty picture placeholder */
	previewPptxSmartArtPictureInsertFor: "Insert a picture for item {{number}}",
	/** Presentation editor — text pane: button beside item {{number}} that replaces the picture in its picture placeholder with one from this device */
	previewPptxSmartArtPictureChangeFor: "Change the picture of item {{number}}"
}
