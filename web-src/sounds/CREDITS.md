# Sound credits

Every cue in this folder is cut from a real recording released under CC0 1.0
(public domain dedication, https://creativecommons.org/publicdomain/zero/1.0/).
CC0 needs no attribution and allows editing, and it is compatible with this
repository's AGPL-3.0 licence. We credit the recordists anyway.

Editing done in code (not part of the shipped app): trims, fades of 1-30 ms,
exponential damping of long marimba tails, mixing two takes, pitch shifts by
resampling (named below), loudness levelling, encoding to 128 kbps mono MP3.
Nothing is synthesized.

## Sources

| id | recording | author | licence | link |
|---|---|---|---|---|
| FS-555190 | "Board Game Pieces.WAV" (board game pieces placed on a wooden board) | taure | CC0 1.0 | https://freesound.org/people/taure/sounds/555190/ |
| VSCO2CE | VS Chamber Orchestra: Community Edition, Percussion (Marimba, Glock) | Versilian Studios; recorded by Sam Gossner and Simon Dalzell | CC0 1.0 | https://github.com/sgossner/VSCO-2-CE |

Freesound audio was taken from the site's high-quality preview of the sound.

## Per file

| file | made from |
|---|---|
| move.mp3 | FS-555190, strike at 104.053 s |
| capture.mp3 | FS-555190, strike at 87.104 s |
| castle.mp3 | FS-555190 strike at 104.053 s, then the 87.104 s strike 65 ms later (x0.8) |
| check.mp3 | FS-555190 strike at 104.053 s + VSCO2CE `Percussion/Glock/glock_medium_C6.wav` (sounds C7) 20 ms in, x0.22, damped |
| promotion.mp3 | FS-555190 strike at 104.053 s + VSCO2CE `glock_medium_C6.wav` 40 ms in, x0.3, damped |
| right.mp3 | VSCO2CE `Percussion/Marimba/Marimba_hit_Outrigger_C4_loud_01.wav` (sounds C5), then `..._G4_loud_01.wav` (sounds G5) 85 ms later, damped |
| wrong.mp3 | VSCO2CE `Marimba_hit_Outrigger_G2_loud_01.wav` (sounds G3) raised 1 semitone, then unshifted 90 ms later, damped |
| complete.mp3 | VSCO2CE marimba C5, C5 raised 4 semitones (E5), G5, `..._C6_loud_01.wav` (sounds C7) lowered 12 semitones (C6), 70 ms apart, with `glock_medium_C6.wav` x0.25 on the top note |

The VSCO2CE file names are an octave below the pitch they sound; the pitches
above are measured.
