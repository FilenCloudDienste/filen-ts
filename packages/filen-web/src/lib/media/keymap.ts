import type { ActionDef } from "@/lib/keymap/registry"

// The media players' keys, registered once for every player: the Videos player, the preview's video player and the
// audio player bar. Each takes them only while focus is inside it (a slider keeps its own arrows, a button its own
// Space and Enter, a menu or a field everything), so single keys are safe there and stay on with single-key shortcuts
// switched off (WCAG 2.1.4 exempts keys active only while their component has focus). A player takes the subset it
// can act on (mediaKeys.logic.ts); the audio bar's app-wide transport chords live with the audio module.

const IN_PLAYER = "videos:mediaHintPlayer"
const IN_VIDEO = "videos:mediaHintVideo"
const IN_VIDEOS_PLAYER = "videos:mediaHintVideosPlayer"

function playerKey<Id extends string>(
	id: Id,
	defaultCombo: string,
	descriptionKey: ActionDef["descriptionKey"],
	hintKey: ActionDef["hintKey"] = IN_PLAYER
): ActionDef & { id: Id } {
	return { id, defaultCombo, scope: "media", descriptionKey, hintKey, keepsCharacterKeys: true }
}

export const MEDIA_ACTIONS = [
	playerKey("media.playPause", "space,k", "videos:playerKeyPlayPause"),
	playerKey("media.seekBack", "arrowleft,j", "videos:playerKeyBack"),
	playerKey("media.seekForward", "arrowright,l", "videos:playerKeyForward"),
	playerKey("media.seekBackLong", "shift+arrowleft", "videos:mediaKeyBackLong"),
	playerKey("media.seekForwardLong", "shift+arrowright", "videos:mediaKeyForwardLong"),
	playerKey("media.toStart", "home", "videos:mediaKeyStart"),
	playerKey("media.toEnd", "end", "videos:mediaKeyEnd"),
	playerKey("media.jump.zero", "0", "videos:mediaKeyJumpZero"),
	playerKey("media.jump.ten", "1", "videos:mediaKeyJumpTen"),
	playerKey("media.jump.twenty", "2", "videos:mediaKeyJumpTwenty"),
	playerKey("media.jump.thirty", "3", "videos:mediaKeyJumpThirty"),
	playerKey("media.jump.forty", "4", "videos:mediaKeyJumpForty"),
	playerKey("media.jump.fifty", "5", "videos:mediaKeyJumpFifty"),
	playerKey("media.jump.sixty", "6", "videos:mediaKeyJumpSixty"),
	playerKey("media.jump.seventy", "7", "videos:mediaKeyJumpSeventy"),
	playerKey("media.jump.eighty", "8", "videos:mediaKeyJumpEighty"),
	playerKey("media.jump.ninety", "9", "videos:mediaKeyJumpNinety"),
	playerKey("media.volumeUp", "arrowup", "videos:mediaKeyVolumeUp"),
	playerKey("media.volumeDown", "arrowdown", "videos:mediaKeyVolumeDown"),
	playerKey("media.mute", "m", "videos:playerKeyMute"),
	playerKey("media.slower", "shift+comma", "videos:mediaKeySlower", IN_VIDEO),
	playerKey("media.faster", "shift+period", "videos:mediaKeyFaster", IN_VIDEO),
	playerKey("media.normalSpeed", "equal", "videos:mediaKeyNormalSpeed", IN_VIDEO),
	playerKey("media.frameBack", "comma", "videos:mediaKeyFrameBack", IN_VIDEO),
	playerKey("media.frameForward", "period", "videos:mediaKeyFrameForward", IN_VIDEO),
	playerKey("media.fullscreen", "f", "videos:playerKeyFullscreen", IN_VIDEO),
	playerKey("media.pictureInPicture", "i", "videos:playerKeyPictureInPicture", IN_VIDEO),
	playerKey("media.previous", "shift+p", "videos:mediaKeyPrevious"),
	playerKey("media.next", "shift+n", "videos:mediaKeyNext"),
	playerKey("media.chapterPrevious", "pageup", "videos:mediaKeyChapterPrevious", IN_VIDEOS_PLAYER),
	playerKey("media.chapterNext", "pagedown", "videos:mediaKeyChapterNext", IN_VIDEOS_PLAYER),
	playerKey("media.skip", "s", "videos:playerKeySkip", IN_VIDEOS_PLAYER),
	playerKey("media.subtitles", "c", "videos:playerKeySubtitles", IN_VIDEOS_PLAYER),
	playerKey("media.subtitleTrack", "shift+c", "videos:mediaKeySubtitleTrack", IN_VIDEOS_PLAYER),
	playerKey("media.subtitleEarlier", "g", "videos:mediaKeySubtitleEarlier", IN_VIDEOS_PLAYER),
	playerKey("media.subtitleLater", "h", "videos:mediaKeySubtitleLater", IN_VIDEOS_PLAYER),
	playerKey("media.subtitleDelayReset", "", "videos:mediaKeySubtitleDelayReset", IN_VIDEOS_PLAYER),
	playerKey("media.audioTrack", "a", "videos:mediaKeyAudioTrack", IN_VIDEOS_PLAYER),
	playerKey("media.episodes", "e", "videos:mediaKeyEpisodes", IN_VIDEOS_PLAYER),
	// Closes what is open over the picture first (a panel, Up Next), then the player.
	playerKey("media.close", "escape", "videos:mediaKeyClose", IN_VIDEOS_PLAYER)
]

export type MediaAction = (typeof MEDIA_ACTIONS)[number]["id"]

// The number keys' actions, in order: the n-th jumps to n tenths of the way through, as on every major video site.
export const MEDIA_JUMP_ACTIONS: readonly MediaAction[] = [
	"media.jump.zero",
	"media.jump.ten",
	"media.jump.twenty",
	"media.jump.thirty",
	"media.jump.forty",
	"media.jump.fifty",
	"media.jump.sixty",
	"media.jump.seventy",
	"media.jump.eighty",
	"media.jump.ninety"
]
