import assert from 'node:assert/strict'
import { buildFfmpegArguments } from '../src/main/media-hub/vlc'

const SOURCE = 'https://media.example.com/movie.mkv'

/** Position of `flag`'s value in an ffmpeg argument list, or -1. */
function valueOf(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag)
  return at === -1 ? undefined : args[at + 1]
}

const base = buildFfmpegArguments(SOURCE)

// The reported crash: a source whose audio streams start later than its
// video (1.008s on the file this was found on) makes the fragmented-mp4
// muxer inflate the first audio sample's declared duration to cover the
// lead-in, so the container promises ~2s of audio timeline that only holds
// ~0.9s of decodable samples and playback dies right about there. Padding
// the lead-in with real silence is what keeps every sample's duration
// honest — see buildFfmpegArguments' own comment.
assert.equal(
  valueOf(base, '-af'),
  'aresample=async=1:first_pts=0',
  'audio is padded to a gap-free timeline starting at 0'
)

// Chapters are copied by their own default, not by -map, and the mp4 muxer
// turns an MKV's chapter list into a third `text` track that emits one
// sample in the first fragment and nothing ever again.
assert.equal(valueOf(base, '-map_chapters'), '-1', 'chapters are not muxed into the stream')

// A Dolby Vision source's RPU rides through stream-copy as in-band NAL
// units regardless of this flag — what it controls is whether the mp4
// muxer is ALLOWED to write the dvcC/dvvC box declaring that. Without it
// the container silently disagrees with the bitstream it's carrying (RPU
// present, nothing saying so); ffmpeg's own stderr names this exact flag
// as the fix ("Not writing 'dvcC'/'dvvC' box. Requires -strict
// unofficial.", logged on every compatibility-mode transcode of such a
// source before this).
assert.equal(valueOf(base, '-strict'), 'unofficial', 'the muxer is allowed to declare Dolby Vision')

// All three belong to the output, so they must come after -i — an -af (or
// -strict, or -map_chapters) placed before the input is parsed as an input
// option and silently ignored. Verified live: -strict specifically only
// took effect from the output side; placed before -i it did not error, it
// just silently had no effect (confirmed by decoding the result and
// checking for the dvcC/dvvC box).
for (const flag of ['-af', '-map_chapters', '-strict']) {
  assert.ok(
    base.indexOf(flag) > base.indexOf('-i'),
    `${flag} is an output option and must follow -i`
  )
}

// Unchanged from before the fix: video is still stream-copied by default,
// and the audio target is still the same stereo 48kHz AAC.
assert.equal(valueOf(base, '-c:v'), 'copy', 'video is still copied by default')
assert.equal(valueOf(base, '-c:a'), 'aac')
assert.equal(valueOf(base, '-ac'), '2')
assert.equal(valueOf(base, '-ar'), '48000')

// The audio normalisation is not specific to the copy path — a forced video
// re-encode muxes into the same fragmented mp4 and needs it just as much.
const reencoded = buildFfmpegArguments(SOURCE, {}, 'h264_nvenc', 1080)
assert.equal(
  valueOf(reencoded, '-af'),
  'aresample=async=1:first_pts=0',
  'audio padding applies on the video re-encode path too'
)
assert.equal(valueOf(reencoded, '-vf'), 'format=yuv420p,scale=-2:1080')

// Every restart (seek, track change, subtitle apply) rebuilds these args,
// so a seeked restart must be normalised the same way the first start was.
const seeked = buildFfmpegArguments(SOURCE, { audio: 2, startTime: 640 })
assert.equal(valueOf(seeked, '-af'), 'aresample=async=1:first_pts=0')
assert.equal(valueOf(seeked, '-strict'), 'unofficial')
assert.equal(valueOf(seeked, '-ss'), '640')
assert.ok(seeked.includes('-noaccurate_seek'), 'keyframe-snapped seek is unchanged')
assert.equal(valueOf(seeked, '-map'), '0:v:0')
assert.ok(seeked.includes('0:a:2'), 'the requested audio ordinal is still what gets mapped')

// The SSRF boundary this function re-checks immediately before every spawn
// is untouched by the above.
assert.throws(
  () => buildFfmpegArguments('http://media.example.com/movie.mkv'),
  /valid HTTPS media URL/,
  'plain http is still rejected'
)
assert.throws(() => buildFfmpegArguments('https://127.0.0.1/movie.mkv'), /valid HTTPS media URL/)

console.log('ffmpegArguments tests passed')
