// "preview" namespace, presentation editor: the Transitions tab (the transition gallery, its effect options, timing,
// sound and advance, apply to all, preview). Spread into preview.ts; same catalog rules.
export const previewPptxTransitions = {
	/** Presentation editor, Transitions tab — group: the transition gallery */
	previewPptxTransitionsGalleryGroup: "Transition to This Slide",
	/** Presentation editor, Transitions tab — the gallery button; opens the list of transitions */
	previewPptxTransitionsGallery: "Transition",
	/** Presentation editor, Transitions tab — gallery section: subtle transitions */
	previewPptxTransitionsSubtle: "Subtle",
	/** Presentation editor, Transitions tab — gallery section: exciting transitions */
	previewPptxTransitionsExciting: "Exciting",
	/** Presentation editor, Transitions tab — gallery section: transitions that move the slide's content */
	previewPptxTransitionsDynamic: "Dynamic Content",
	/** Presentation editor, Transitions tab — gallery entry: no transition */
	previewPptxTransitionNone: "None",
	/** Presentation editor, Transitions tab — plays the slide's transition on the slide */
	previewPptxTransitionsPreview: "Preview",
	/** Presentation editor, Transitions tab — group: the transition's effect options */
	previewPptxTransitionsOptionsGroup: "Effect Options",
	/** Presentation editor, Transitions tab — the effect options button */
	previewPptxTransitionsOptions: "Effect Options",
	/** Presentation editor, Transitions tab — the effect options menu when the transition has none */
	previewPptxTransitionsNoOptions: "This transition has no effect options.",
	/** Presentation editor, Transitions tab — group: duration, sound, advance and apply to all */
	previewPptxTransitionsTimingGroup: "Timing",
	/** Presentation editor, Transitions tab — duration field label, in seconds */
	previewPptxTransitionsDuration: "Duration (s)",
	/** Presentation editor, Transitions tab — the sound menu */
	previewPptxTransitionsSound: "Sound",
	/** Presentation editor, Transitions tab — sound menu entry: no sound */
	previewPptxTransitionsSoundNone: "No Sound",
	/** Presentation editor, Transitions tab — sound menu entry: stops a sound playing from an earlier slide */
	previewPptxTransitionsSoundStop: "Stop Previous Sound",
	/** Presentation editor, Transitions tab — sound menu entry: the sound plays again until the next sound starts */
	previewPptxTransitionsSoundLoop: "Loop Until Next Sound",
	/** Presentation editor, Transitions tab — sound menu entry: picks a WAV file from this device to play with the transition */
	previewPptxTransitionsSoundOther: "Other Sound…",
	/** Presentation editor, Transitions tab — toast: the picked file is not a WAV sound */
	previewPptxTransitionsSoundNotWav: "Transition sounds must be WAV files.",
	/** Presentation editor, Transitions tab — toast: the picked sound could not be read */
	previewPptxTransitionsSoundFailed: "The sound couldn't be added.",
	/** Presentation editor, Transitions tab — checkbox: the slide advances on a click */
	previewPptxTransitionsOnClick: "On Mouse Click",
	/** Presentation editor, Transitions tab — checkbox: the slide advances by itself after a time */
	previewPptxTransitionsAfter: "After (s)",
	/** Presentation editor, Transitions tab — sets the slide's transition on every slide */
	previewPptxTransitionsApplyAll: "Apply To All",
	/** Presentation editor, Transitions tab — the gallery when the slide's transition could not be read */
	previewPptxTransitionsUnreadable: "This slide's transition couldn't be read.",
	/** Presentation editor, Transitions tab — under the gallery: this transition plays as its simpler fallback here */
	previewPptxTransitionsPlaysFallback: "Plays as {{fallback}} here; PowerPoint plays it in full.",

	/** Transition gallery — Morph */
	previewPptxTransitionMorph: "Morph",
	/** Transition gallery — Fade */
	previewPptxTransitionFade: "Fade",
	/** Transition gallery — Push */
	previewPptxTransitionPush: "Push",
	/** Transition gallery — Wipe */
	previewPptxTransitionWipe: "Wipe",
	/** Transition gallery — Split */
	previewPptxTransitionSplit: "Split",
	/** Transition gallery — Reveal */
	previewPptxTransitionReveal: "Reveal",
	/** Transition gallery — Cut (no animation) */
	previewPptxTransitionCut: "Cut",
	/** Transition gallery — Random Bars */
	previewPptxTransitionRandomBar: "Random Bars",
	/** Transition gallery — Circle */
	previewPptxTransitionCircle: "Circle",
	/** Transition gallery — Diamond */
	previewPptxTransitionDiamond: "Diamond",
	/** Transition gallery — Plus */
	previewPptxTransitionPlus: "Plus",
	/** Transition gallery — Zoom (the slide box grows or shrinks) */
	previewPptxTransitionZoom: "Zoom",
	/** Transition gallery — Uncover (the old slide moves off) */
	previewPptxTransitionPull: "Uncover",
	/** Transition gallery — Cover (the new slide moves in over the old one) */
	previewPptxTransitionCover: "Cover",
	/** Transition gallery — Flash */
	previewPptxTransitionFlash: "Flash",
	/** Transition gallery — Strips */
	previewPptxTransitionStrips: "Strips",
	/** Transition gallery — Wedge */
	previewPptxTransitionWedge: "Wedge",
	/** Transition gallery — Fall Over */
	previewPptxTransitionFallOver: "Fall Over",
	/** Transition gallery — Drape */
	previewPptxTransitionDrape: "Drape",
	/** Transition gallery — Curtains */
	previewPptxTransitionCurtains: "Curtains",
	/** Transition gallery — Wind */
	previewPptxTransitionWind: "Wind",
	/** Transition gallery — Prestige */
	previewPptxTransitionPrestige: "Prestige",
	/** Transition gallery — Fracture */
	previewPptxTransitionFracture: "Fracture",
	/** Transition gallery — Crush */
	previewPptxTransitionCrush: "Crush",
	/** Transition gallery — Peel Off */
	previewPptxTransitionPeelOff: "Peel Off",
	/** Transition gallery — Page Curl, both pages */
	previewPptxTransitionPageCurlDouble: "Page Curl (double)",
	/** Transition gallery — Page Curl, one page */
	previewPptxTransitionPageCurlSingle: "Page Curl (single)",
	/** Transition gallery — Airplane */
	previewPptxTransitionAirplane: "Airplane",
	/** Transition gallery — Origami */
	previewPptxTransitionOrigami: "Origami",
	/** Transition gallery — Dissolve */
	previewPptxTransitionDissolve: "Dissolve",
	/** Transition gallery — Checkerboard */
	previewPptxTransitionChecker: "Checkerboard",
	/** Transition gallery — Blinds */
	previewPptxTransitionBlinds: "Blinds",
	/** Transition gallery — Clock (wheel) */
	previewPptxTransitionWheel: "Clock",
	/** Transition gallery — Clock turning the other way */
	previewPptxTransitionWheelReverse: "Counterclockwise",
	/** Transition gallery — Ripple */
	previewPptxTransitionRipple: "Ripple",
	/** Transition gallery — Honeycomb */
	previewPptxTransitionHoneycomb: "Honeycomb",
	/** Transition gallery — Glitter */
	previewPptxTransitionGlitter: "Glitter",
	/** Transition gallery — Vortex */
	previewPptxTransitionVortex: "Vortex",
	/** Transition gallery — Shred */
	previewPptxTransitionShred: "Shred",
	/** Transition gallery — Switch */
	previewPptxTransitionSwitch: "Switch",
	/** Transition gallery — Flip */
	previewPptxTransitionFlip: "Flip",
	/** Transition gallery — Gallery (slides moving like pictures on a wall) */
	previewPptxTransitionGallery: "Gallery",
	/** Transition gallery — Cube / prism rotation */
	previewPptxTransitionPrism: "Cube",
	/** Transition gallery — Doors */
	previewPptxTransitionDoors: "Doors",
	/** Transition gallery — Comb */
	previewPptxTransitionComb: "Comb",
	/** Transition gallery — Warp (zoom through the slide) */
	previewPptxTransitionWarp: "Warp",
	/** Transition gallery — Newsflash (spins in) */
	previewPptxTransitionNewsflash: "Newsflash",
	/** Transition gallery — a transition picked at random when the show plays */
	previewPptxTransitionRandom: "Random",
	/** Transition gallery — Pan */
	previewPptxTransitionPan: "Pan",
	/** Transition gallery — Ferris Wheel */
	previewPptxTransitionFerris: "Ferris Wheel",
	/** Transition gallery — Conveyor */
	previewPptxTransitionConveyor: "Conveyor",
	/** Transition gallery — Window */
	previewPptxTransitionWindow: "Window",
	/** Transition gallery — Fly Through */
	previewPptxTransitionFlythrough: "Fly Through",

	/** Effect options — heading: the direction */
	previewPptxTransitionOptionDir: "Direction",
	/** Effect options — heading: the orientation */
	previewPptxTransitionOptionOrient: "Orientation",
	/** Effect options — heading: the pattern */
	previewPptxTransitionOptionPattern: "Pattern",
	/** Effect options — heading: how many spokes the clock has */
	previewPptxTransitionOptionSpokes: "Spokes",
	/** Effect options — heading: how morph matches objects */
	previewPptxTransitionOptionMorph: "Match",
	/** Effect options — through black */
	previewPptxTransitionOptionThruBlk: "Through Black",
	/** Effect options — the slide's content turns, its background stays */
	previewPptxTransitionOptionIsContent: "Content Only",
	/** Effect options — the cube turns inward */
	previewPptxTransitionOptionIsInverted: "Inverted",
	/** Effect options — the slide bounces as it lands */
	previewPptxTransitionOptionHasBounce: "With Bounce",
	/** Effect options — the effect runs from the right instead of the left */
	previewPptxTransitionOptionInvX: "From Right",
	/** Effect options — the effect runs from the bottom instead of the top */
	previewPptxTransitionOptionInvY: "From Bottom",
	/** Effect options — direction: from the right (moves left) */
	previewPptxTransitionDirL: "From Right",
	/** Effect options — direction: from the bottom (moves up) */
	previewPptxTransitionDirU: "From Bottom",
	/** Effect options — direction: from the left (moves right) */
	previewPptxTransitionDirR: "From Left",
	/** Effect options — direction: from the top (moves down) */
	previewPptxTransitionDirD: "From Top",
	/** Effect options — direction: from the bottom right corner */
	previewPptxTransitionDirLu: "From Bottom-Right",
	/** Effect options — direction: from the bottom left corner */
	previewPptxTransitionDirRu: "From Bottom-Left",
	/** Effect options — direction: from the top right corner */
	previewPptxTransitionDirLd: "From Top-Right",
	/** Effect options — direction: from the top left corner */
	previewPptxTransitionDirRd: "From Top-Left",
	/** Effect options — direction: from the centre */
	previewPptxTransitionDirCenter: "Center",
	/** Effect options — direction: inward */
	previewPptxTransitionDirIn: "In",
	/** Effect options — direction: outward */
	previewPptxTransitionDirOut: "Out",
	/** Effect options — orientation: horizontal */
	previewPptxTransitionHorz: "Horizontal",
	/** Effect options — orientation: vertical */
	previewPptxTransitionVert: "Vertical",
	/** Effect options — pattern: diamonds */
	previewPptxTransitionPatternDiamond: "Diamonds",
	/** Effect options — pattern: hexagons */
	previewPptxTransitionPatternHexagon: "Hexagons",
	/** Effect options — pattern: strips */
	previewPptxTransitionPatternStrip: "Strips",
	/** Effect options — pattern: particles (rectangles) */
	previewPptxTransitionPatternRectangle: "Particles",
	/** Effect options — morph matches objects */
	previewPptxTransitionMorphByObject: "Objects",
	/** Effect options — morph matches words */
	previewPptxTransitionMorphByWord: "Words",
	/** Effect options — morph matches characters */
	previewPptxTransitionMorphByChar: "Characters",
	/** Effect options — a clock with {{count}} spokes */
	previewPptxTransitionSpokes_one: "{{count}} spoke",
	/** Effect options — as previewPptxTransitionSpokes_one, for several */
	previewPptxTransitionSpokes_other: "{{count}} spokes"
}
