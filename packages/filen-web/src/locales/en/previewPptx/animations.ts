// "preview" namespace, presentations: the Animations tab (the effect gallery, Effect Options, timing, trigger, preview)
// and the Animation Pane. Spread into preview.ts; same catalog rules.
export const previewPptxAnimations = {
	/** Presentation editor, Animations tab — group of the Preview command */
	previewPptxAnimPreviewGroup: "Preview",
	/** Presentation editor, Animations tab — plays the slide's animations on the slide being edited */
	previewPptxAnimPreview: "Preview",
	/** Presentation editor, Animations tab — stops the animations playing on the slide */
	previewPptxAnimStopPreview: "Stop",
	/** Presentation editor, Animations tab — group of the effect gallery and its options */
	previewPptxAnimAnimationGroup: "Animation",
	/** Presentation editor, Animations tab — gallery of animation effects; picking one sets it on the selected objects */
	previewPptxAnimEffects: "Effects",
	/** Presentation editor, Animations tab — gallery item that removes the selected objects" animations */
	previewPptxAnimNone: "None",
	/** Presentation editor, Animations tab — gallery section: effects that bring an object onto the slide */
	previewPptxAnimClassEntr: "Entrance",
	/** Presentation editor, Animations tab — gallery section: effects that draw attention to an object on the slide */
	previewPptxAnimClassEmph: "Emphasis",
	/** Presentation editor, Animations tab — gallery section: effects that take an object off the slide */
	previewPptxAnimClassExit: "Exit",
	/** Presentation editor, Animations tab — gallery section: effects that move an object along a path */
	previewPptxAnimClassPath: "Motion Paths",
	/** Presentation editor, Animations tab — menu of the selected effect's options (direction, sequence, colour) */
	previewPptxAnimEffectOptions: "Effect Options",
	/** Presentation editor, Animations tab — Effect Options section: which way the effect goes */
	previewPptxAnimDirection: "Direction",
	/** Presentation editor, Animations tab — Effect Options section: how a text object is animated */
	previewPptxAnimSequence: "Sequence",
	/** Presentation editor, Animations tab — Effect Options: the text object is animated whole */
	previewPptxAnimAsOneObject: "As One Object",
	/** Presentation editor, Animations tab — Effect Options: each paragraph of the text is animated on its own */
	previewPptxAnimByParagraph: "By Paragraph",
	/** Presentation editor, Animations tab — Effect Options section: how the letters of the text are animated */
	previewPptxAnimAnimateText: "Animate Text",
	/** Presentation editor, Animations tab — Effect Options: all of the text at once */
	previewPptxAnimAllAtOnce: "All at Once",
	/** Presentation editor, Animations tab — Effect Options: word by word */
	previewPptxAnimByWord: "By Word",
	/** Presentation editor, Animations tab — Effect Options: letter by letter */
	previewPptxAnimByLetter: "By Letter",
	/** Presentation editor, Animations tab — Effect Options section: the colour a colour effect changes to */
	previewPptxAnimColor: "Color",
	/** Presentation editor, Animations tab — Effect Options: one of the theme's accent colours; {{n}} is 1 to 6 */
	previewPptxAnimAccent: "Accent {{n}}",
	/** Presentation editor, Animations tab — group of Add Animation, the Animation Pane and the trigger */
	previewPptxAnimAdvancedGroup: "Advanced Animation",
	/** Presentation editor, Animations tab — gallery that adds another effect to the selected objects */
	previewPptxAnimAdd: "Add Animation",
	/** Presentation editor, Animations tab — shows or hides the list of the slide's animations */
	previewPptxAnimPane: "Animation Pane",
	/** Presentation editor, Animations tab — menu: what starts the selected effect */
	previewPptxAnimTrigger: "Trigger",
	/** Presentation editor, Animations tab — Trigger menu: the effect plays in the slide's click sequence */
	previewPptxAnimTriggerSequence: "On Click Sequence",
	/** Presentation editor, Animations tab — Trigger menu: the effect plays when this object is clicked; {{name}} is the object */
	previewPptxAnimTriggerShape: "On Click of {{name}}",
	/** Presentation editor, Animations tab — group of the selected effect's timing */
	previewPptxAnimTimingGroup: "Timing",
	/** Presentation editor, Animations tab — when the selected effect starts */
	previewPptxAnimStart: "Start",
	/** Presentation editor, Animations tab — Start: the effect plays on the next click */
	previewPptxAnimStartClick: "On Click",
	/** Presentation editor, Animations tab — Start: the effect plays together with the one before it */
	previewPptxAnimStartWith: "With Previous",
	/** Presentation editor, Animations tab — Start: the effect plays when the one before it ends */
	previewPptxAnimStartAfter: "After Previous",
	/** Presentation editor, Animations tab — field: how long the effect plays, in seconds */
	previewPptxAnimDuration: "Duration",
	/** Presentation editor, Animations tab — field: how long the effect waits before it plays, in seconds */
	previewPptxAnimDelay: "Delay",
	/** Presentation editor, Animations tab — unit after a duration or delay field: seconds */
	previewPptxAnimSeconds: "s",
	/** Presentation editor, Animations tab — error: a duration or delay outside its range; {{max}} is a number of seconds */
	previewPptxAnimSecondsRange: "Enter 0 to {{max}} seconds.",
	/** Presentation editor, Animations tab — moves the selected effect one place earlier in the list */
	previewPptxAnimEarlier: "Move Earlier",
	/** Presentation editor, Animations tab — moves the selected effect one place later in the list */
	previewPptxAnimLater: "Move Later",
	/** Presentation editor, Animations tab — menu: how often the selected effect plays */
	previewPptxAnimRepeat: "Repeat",
	/** Presentation editor, Animations tab — Repeat: the effect plays once */
	previewPptxAnimRepeatOnce: "None",
	/** Presentation editor, Animations tab — Repeat: the effect plays this many times; {{count}} is 2, 3, 4, 5 or 10 */
	previewPptxAnimRepeatTimes: "{{count}} times",
	/** Presentation editor, Animations tab — Repeat: the effect repeats until the next click */
	previewPptxAnimRepeatNextClick: "Until Next Click",
	/** Presentation editor, Animations tab — Repeat: the effect repeats until the slide ends */
	previewPptxAnimRepeatEndOfSlide: "Until End of Slide",
	/** Presentation editor, Animations tab — option: the object goes back to how it was when the effect ends */
	previewPptxAnimRewind: "Rewind When Done",
	/** Presentation editor, Animations tab — status: select an object on the slide to animate it */
	previewPptxAnimNoSelection: "Select an object to animate it.",
	/** Presentation editor, Animations tab — the slide's animations are arranged in a way the editor can't change; they still play */
	previewPptxAnimUnsupported: "This slide's animations can't be edited here, but they still play in the slide show.",
	/** Presentation editor — title of the pane listing the slide's animations */
	previewPptxAnimPaneTitle: "Animation Pane",
	/** Presentation editor, Animation Pane — closes the pane */
	previewPptxAnimPaneClose: "Close the Animation Pane",
	/** Presentation editor, Animation Pane — the slide has no animations */
	previewPptxAnimPaneEmpty: "This slide has no animations. Select an object and choose an effect on the Animations tab.",
	/** Presentation editor, Animation Pane — the slide's animations are being read */
	previewPptxAnimPaneLoading: "Reading the animations…",
	/** Presentation editor, Animation Pane — plays the slide's animations from the selected effect */
	previewPptxAnimPlayFrom: "Play From",
	/** Presentation editor, Animation Pane — plays all of the slide's animations */
	previewPptxAnimPlayAll: "Play All",
	/** Presentation editor, Animation Pane — removes the selected effects */
	previewPptxAnimRemove: "Remove",
	/** Presentation editor, Animation Pane — heading of the effects that play when an object is clicked; {{name}} is the object */
	previewPptxAnimTriggerHeading: "Trigger: {{name}}",
	/** Presentation editor — name of an object on the slide by its number, where it has no alt text */
	previewPptxAnimShape: "Object {{id}}",
	/** Presentation editor, Animation Pane — an effect on one paragraph of an object's text; {{n}} is the paragraph number */
	previewPptxAnimParagraph: "paragraph {{n}}",
	/** Presentation editor, Animation Pane — an effect named with its class, so an entrance and an exit of the same name differ; {{kind}} is Entrance, Emphasis, Exit or Motion Paths, {{effect}} the effect's name */
	previewPptxAnimEffectOfClass: "{{kind}}: {{effect}}",
	/** Presentation editor, Animation Pane — accessible name of one effect in the list: its number, effect name, object and start */
	previewPptxAnimRow: "{{effect}}: {{target}}, {{start}}",
	/** Presentation editor, Animation Pane — keyboard help for the effect list */
	previewPptxAnimReorderHint: "Alt+Up or Alt+Down moves the selected effect. Delete removes it.",
	/** Presentation editor, Animation Pane — screen reader announcement after an effect moved; {{n}} is its new position */
	previewPptxAnimMoved: "Moved to position {{n}}.",
	/** Presentation editor — an effect the file names with no preset we know */
	previewPptxAnimUnknownEffect: "Custom",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirFromTop: "From Top",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirFromRight: "From Right",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirFromBottom: "From Bottom",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirFromLeft: "From Left",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirFromTopRight: "From Top-Right",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirFromBottomRight: "From Bottom-Right",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirFromBottomLeft: "From Bottom-Left",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirFromTopLeft: "From Top-Left",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirHorizontal: "Horizontal",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirVertical: "Vertical",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirAcross: "Across",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirDown: "Down",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirIn: "In",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirOut: "Out",
	/** Presentation editor, Animations tab — Effect Options direction: from the middle of the slide */
	previewPptxAnimDirInCenter: "In From Screen Center",
	/** Presentation editor, Animations tab — Effect Options direction: to the middle of the slide */
	previewPptxAnimDirOutCenter: "Out To Screen Center",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirVerticalIn: "Vertical In",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirHorizontalIn: "Horizontal In",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirVerticalOut: "Vertical Out",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirHorizontalOut: "Horizontal Out",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirLeftDown: "Left Down",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirLeftUp: "Left Up",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirRightDown: "Right Down",
	/** Presentation editor, Animations tab — Effect Options direction */
	previewPptxAnimDirRightUp: "Right Up",
	/** Presentation editor, Animations tab — Effect Options for Wheel: the number of spokes */
	previewPptxAnimDirSpokes_one: "{{count}} Spoke",
	/** Presentation editor, Animations tab — Effect Options for Wheel: the number of spokes */
	previewPptxAnimDirSpokes_other: "{{count}} Spokes",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetAppear: "Appear",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetArcDown: "Arc Down",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetArcLeft: "Arc Left",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetArcRight: "Arc Right",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetArcUp: "Arc Up",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetAscend: "Ascend",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetBlinds: "Blinds",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetBlink: "Blink",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetBoldFlash: "Bold Flash",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetBoldReveal: "Bold Reveal",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetBounce: "Bounce",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetBox: "Box",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetCheckerboard: "Checkerboard",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetCircle: "Circle",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetCollapse: "Collapse",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetColorBlend: "Color Blend",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetComplementaryColor: "Complementary Color",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetCompress: "Compress",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetContract: "Contract",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetCrawlIn: "Crawl In",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetCrawlOut: "Crawl Out",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetDarken: "Darken",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetDesaturate: "Desaturate",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetDescend: "Descend",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetDiagonalDownRight: "Diagonal Down Right",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetDiagonalUpRight: "Diagonal Up Right",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetDiamond: "Diamond",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetDisappear: "Disappear",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetDissolveIn: "Dissolve In",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetDissolveOut: "Dissolve Out",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetDown: "Down",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetExpand: "Expand",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetFade: "Fade",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetFadedZoom: "Faded Zoom",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetFillColor: "Fill Color",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetFivePointStar: "5-Point Star",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetFlicker: "Flicker",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetFloat: "Float",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetFlyIn: "Fly In",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetFlyOut: "Fly Out",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetFontColor: "Font Color",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetFontStyle: "Bold and Italic",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetGrowShrink: "Grow/Shrink",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetGrowWithColor: "Grow With Color",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetHeart: "Heart",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetHexagon: "Hexagon",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetLeft: "Left",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetLighten: "Lighten",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetLineColor: "Line Color",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetLoopDeLoop: "Loop de Loop",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetOval: "Oval",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetPeekIn: "Peek In",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetPeekOut: "Peek Out",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetPlus: "Plus",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetPulse: "Pulse",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetRandomBars: "Random Bars",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetRight: "Right",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetRiseUp: "Rise Up",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetSinkDown: "Sink Down",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetSpin: "Spin",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetSpiralIn: "Spiral In",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetSpiralOut: "Spiral Out",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetSplit: "Split",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetSquare: "Square",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetStretch: "Stretch",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetStretchy: "Stretchy",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetStrips: "Strips",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetSwivel: "Swivel",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetTeeter: "Teeter",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetTransparency: "Transparency",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetTriangle: "Triangle",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetTurnDown: "Turn Down",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetTurnDownRight: "Turn Down Right",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetTurnUp: "Turn Up",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetTurnUpRight: "Turn Up Right",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetUnderline: "Underline",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetUp: "Up",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetVerticalFigureEight: "Vertical Figure 8",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetWedge: "Wedge",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetWheel: "Wheel",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetWipe: "Wipe",
	/** Presentation editor — name of an animation effect */
	previewPptxAnimPresetZoom: "Zoom"
}
