// "preview" namespace, presentation editor: selecting shapes on the slide, moving, resizing and turning them, and the
// Arrange tab (order, group, align, rotate, alt text, actions). Spread into preview.ts; same catalog rules.
export const previewPptxArrange = {
	/** Presentation editor — accessible name of the slide while shapes on it can be selected and moved */
	previewPptxCanvasLabel: "Slide editor",
	/** Presentation editor — accessible description of the slide editor: Tab moves between the objects on the slide, so this says how to leave it */
	previewPptxCanvasKeys: "Tab and Shift+Tab move between objects. Press F6 to go to the ribbon.",
	/** Presentation editor — screen reader announcement: one shape is selected; {{name}} is what it is, e.g. "Picture" */
	previewPptxSelectedOne: "{{name}} selected",
	/** Presentation editor — screen reader announcement: one shape with alt text is selected, e.g. "Picture, Company logo, selected" */
	previewPptxSelectedNamed: "{{name}}, {{alt}}, selected",
	/** Presentation editor — screen reader announcement: several shapes are selected */
	previewPptxSelectedMany_one: "{{count}} object selected",
	/** Presentation editor — screen reader announcement: several shapes are selected */
	previewPptxSelectedMany_other: "{{count}} objects selected",
	/** Presentation editor — what a selected object is, in announcements */
	previewPptxObjectShape: "Shape",
	/** Presentation editor — what a selected object is, in announcements */
	previewPptxObjectPlaceholder: "Placeholder",
	/** Presentation editor — what a selected object is, in announcements */
	previewPptxObjectPicture: "Picture",
	/** Presentation editor — what a selected object is, in announcements */
	previewPptxObjectTable: "Table",
	/** Presentation editor — what a selected object is, in announcements */
	previewPptxObjectChart: "Chart",
	/** Presentation editor — what a selected object is, in announcements */
	previewPptxObjectSmartArt: "SmartArt graphic",
	/** Presentation editor — what a selected object is, in announcements */
	previewPptxObjectMedia: "Media",
	/** Presentation editor — what a selected object is, in announcements: an embedded object such as a spreadsheet */
	previewPptxObjectEmbedded: "Embedded object",
	/** Presentation editor — what a selected object is, in announcements: pen or highlighter drawing */
	previewPptxObjectInk: "Ink",
	/** Presentation editor — what a selected object is, in announcements */
	previewPptxObjectGroup: "Group",

	/** Presentation editor, Arrange tab — group of the stacking order commands */
	previewPptxArrangeOrder: "Order",
	/** Presentation editor, Arrange tab — moves the selected objects one step in front */
	previewPptxBringForward: "Bring forward",
	/** Presentation editor, Arrange tab — moves the selected objects in front of all others */
	previewPptxBringToFront: "Bring to front",
	/** Presentation editor, Arrange tab — moves the selected objects one step behind */
	previewPptxSendBackward: "Send backward",
	/** Presentation editor, Arrange tab — moves the selected objects behind all others */
	previewPptxSendToBack: "Send to back",
	/** Presentation editor, Arrange tab — group of the group and ungroup commands */
	previewPptxArrangeGroup: "Group",
	/** Presentation editor, Arrange tab — joins the selected objects into one group */
	previewPptxGroup: "Group",
	/** Presentation editor, Arrange tab — splits the selected groups into their objects */
	previewPptxUngroup: "Ungroup",
	/** Presentation editor, Arrange tab — group and menu of the align and distribute commands */
	previewPptxArrangeAlign: "Align",
	/** Presentation editor, Arrange tab, Align menu */
	previewPptxAlignLeft: "Align left",
	/** Presentation editor, Arrange tab, Align menu */
	previewPptxAlignCenter: "Align center",
	/** Presentation editor, Arrange tab, Align menu */
	previewPptxAlignRight: "Align right",
	/** Presentation editor, Arrange tab, Align menu */
	previewPptxAlignTop: "Align top",
	/** Presentation editor, Arrange tab, Align menu */
	previewPptxAlignMiddle: "Align middle",
	/** Presentation editor, Arrange tab, Align menu */
	previewPptxAlignBottom: "Align bottom",
	/** Presentation editor, Arrange tab, Align menu — equal horizontal gaps between the selected objects */
	previewPptxDistributeHorizontally: "Distribute horizontally",
	/** Presentation editor, Arrange tab, Align menu — equal vertical gaps between the selected objects */
	previewPptxDistributeVertically: "Distribute vertically",
	/** Presentation editor, Arrange tab, Align menu — option: align and distribute against the slide's edges */
	previewPptxAlignToSlide: "Align to slide",
	/** Presentation editor, Arrange tab, Align menu — option: align and distribute against the selection's own bounds */
	previewPptxAlignToSelection: "Align selected objects",
	/** Presentation editor, Arrange tab — group and menu of the rotate and flip commands */
	previewPptxArrangeRotate: "Rotate",
	/** Presentation editor, Arrange tab, Rotate menu */
	previewPptxRotateRight: "Rotate right 90°",
	/** Presentation editor, Arrange tab, Rotate menu */
	previewPptxRotateLeft: "Rotate left 90°",
	/** Presentation editor, Arrange tab, Rotate menu */
	previewPptxFlipVertical: "Flip vertical",
	/** Presentation editor, Arrange tab, Rotate menu */
	previewPptxFlipHorizontal: "Flip horizontal",

	/** Presentation editor, Arrange tab — group of the accessibility and action commands */
	previewPptxArrangeObject: "Object",
	/** Presentation editor, Arrange tab — opens the alt text dialog of the selected object */
	previewPptxAltText: "Alt text…",
	/** Presentation editor — alt text dialog title */
	previewPptxAltTextTitle: "Alt text",
	/** Presentation editor — alt text dialog: what it is for */
	previewPptxAltTextDescription: "Describe the object for people who can't see it.",
	/** Presentation editor — alt text dialog: the description field's label */
	previewPptxAltTextLabel: "Description",
	/** Presentation editor — alt text dialog: the optional short title field's label */
	previewPptxAltTextTitleLabel: "Title",
	/** Presentation editor — alt text dialog: switch for objects that carry no meaning (borders, decoration); screen readers skip them */
	previewPptxAltTextDecorative: "Mark as decorative",
	/** Presentation editor, Arrange tab — opens the dialog that sets what clicking the object in the slide show does */
	previewPptxAction: "Action…",
	/** Presentation editor — action dialog title */
	previewPptxActionTitle: "Action",
	/** Presentation editor — action dialog: what it is for */
	previewPptxActionDescription: "Choose what happens when this object is clicked in the slide show.",
	/** Presentation editor — action dialog: which pointer event the action is for */
	previewPptxActionTrigger: "When",
	/** Presentation editor — action dialog trigger: on a click */
	previewPptxActionOnClick: "Clicked",
	/** Presentation editor — action dialog trigger: when the pointer moves over the object (the slide show never acts on it) */
	previewPptxActionOnHover: "Pointed at (not run in the slide show)",
	/** Presentation editor — action dialog: the action's kind */
	previewPptxActionKind: "Action",
	/** Presentation editor — action kind: nothing happens */
	previewPptxActionNone: "None",
	/** Presentation editor — action kind */
	previewPptxActionNext: "Next slide",
	/** Presentation editor — action kind */
	previewPptxActionPrevious: "Previous slide",
	/** Presentation editor — action kind */
	previewPptxActionFirst: "First slide",
	/** Presentation editor — action kind */
	previewPptxActionLast: "Last slide",
	/** Presentation editor — action kind: back to the slide viewed before */
	previewPptxActionLastViewed: "Last slide viewed",
	/** Presentation editor — action kind */
	previewPptxActionEnd: "End show",
	/** Presentation editor — action kind: go to a chosen slide */
	previewPptxActionSlide: "Slide…",
	/** Presentation editor — action kind: open a web address or an email link */
	previewPptxActionUrl: "Link",
	/** Presentation editor — action kind: play a custom show */
	previewPptxActionCustomShow: "Custom show",
	/** Presentation editor — action kind: play the object's own video or sound */
	previewPptxActionPlayMedia: "Play media",
	/** Presentation editor — action dialog: the slide chosen to go to; {{number}} is its number */
	previewPptxActionSlideNumber: "Slide {{number}}",
	/** Presentation editor — action dialog: label of the slide picker */
	previewPptxActionSlideLabel: "Slide",
	/** Presentation editor — action dialog: label of the custom show picker */
	previewPptxActionCustomShowLabel: "Custom show",
	/** Presentation editor — action dialog: after the custom show, come back to this slide */
	previewPptxActionReturn: "Return after showing",
	/** Presentation editor — action dialog: label of the link field */
	previewPptxActionUrlLabel: "Address",
	/** Presentation editor — action dialog: error under the link field */
	previewPptxActionUrlInvalid: "Enter a web address starting with http:// or https://, or a mailto: link.",
	/** Presentation editor — action dialog: the object has an action the editor can't run or change (a program, a macro, a file); it is kept as it is unless removed */
	previewPptxActionRefusedKept: "This object runs something that isn't allowed here ({{what}}). It's kept as it is unless you remove it.",
	/** Presentation editor — action dialog: kind of refused action */
	previewPptxActionRefusedProgram: "a program",
	/** Presentation editor — action dialog: kind of refused action */
	previewPptxActionRefusedMacro: "a macro",
	/** Presentation editor — action dialog: kind of refused action */
	previewPptxActionRefusedOle: "an embedded object's command",
	/** Presentation editor — action dialog: kind of refused action */
	previewPptxActionRefusedFile: "a file",
	/** Presentation editor — action dialog: kind of refused action */
	previewPptxActionRefusedScript: "a script",
	/** Presentation editor — action dialog: kind of refused action */
	previewPptxActionRefusedExecute: "a command",
	/** Presentation editor — action dialog: kind of refused action */
	previewPptxActionRefusedScheme: "a link of an unsupported kind",
	/** Presentation editor — action dialog: keeps the refused action as it is */
	previewPptxActionKeep: "Keep it",
	/** Presentation editor — dialogs: confirm */
	previewPptxArrangeApply: "Apply",
	/** Presentation editor — dialogs: dismiss without changes */
	previewPptxArrangeCancel: "Cancel",

	/** Keyboard shortcuts — presentation editor: select every object on the slide */
	previewPptxShortcutSelectAll: "Select all objects on the slide",
	/** Keyboard shortcuts — presentation editor */
	previewPptxShortcutGroup: "Group the selected objects",
	/** Keyboard shortcuts — presentation editor */
	previewPptxShortcutUngroup: "Ungroup the selected groups",
	/** Keyboard shortcuts — presentation editor */
	previewPptxShortcutBringToFront: "Bring the selected objects to front",
	/** Keyboard shortcuts — presentation editor */
	previewPptxShortcutSendToBack: "Send the selected objects to back",
	/** Keyboard shortcuts — presentation editor */
	previewPptxShortcutBringForward: "Bring the selected objects forward",
	/** Keyboard shortcuts — presentation editor */
	previewPptxShortcutSendBackward: "Send the selected objects backward"
} as const
