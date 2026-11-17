import { AUDIO_FORMATS, type AudioFormat } from "./fileFamilies"

// Audio a synthesizer renders: a MIDI song, or a tracker module.
export type AudioSynthKind = NonNullable<AudioFormat["synth"]>

// The synthesizer the file `extension` (its type extension, lower case) needs, from its AUDIO_FORMATS row; undefined
// for a format that is decoded.
export function audioSynthKind(extension: string): AudioSynthKind | undefined {
	return AUDIO_FORMATS.get(extension)?.synth
}
