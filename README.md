# MKV to MP4

A personal macOS converter, built like the sibling `ytmp` app: a native window, a minimal interface, a local Node.js server, and FFmpeg. Select or drop an MKV file, convert, then save the MP4 with the macOS Save dialog. Files stay on your Mac.

## macOS app

```sh
brew install ffmpeg
npm run desktop:build
open "dist/MKV to MP4.app"
```

The app requires macOS 13+, and builds for this Mac's architecture. It bundles Node.js and the interface; FFmpeg and FFprobe must remain installed in `/opt/homebrew/bin`, `/usr/local/bin`, or on PATH. The app can be moved independently of this repository. It is locally signed, not notarized.

## Browser version

Requires Node.js 20+ and FFmpeg/FFprobe on PATH. No npm dependencies are needed.

```sh
npm start
```

Open [127.0.0.1:3001](http://127.0.0.1:3001). `PORT`, `FFMPEG_PATH`, `FFPROBE_PATH`, and `CONVERSIONS_DIR` can override defaults.

## Conversion behavior

- **Auto:** copies 8-bit H.264 video with 4:2:0 chroma without re-encoding. Other video is encoded to H.264 at CRF 20, using the source resolution and frame rate. Odd dimensions are padded to even dimensions. Existing AAC audio is copied; other audio is converted to AAC at 192 kbps per track.
- **Re-encode:** always encodes video to H.264 and audio to AAC with those settings.
- Keeps the first non-cover-art video track, all audio tracks, and chapters. Subtitles, extra video tracks, and attachments are omitted. HDR-to-SDR tone mapping is not implemented; HDR inputs may have altered colors when re-encoded.
- Two simultaneous jobs, each up to 20 GB. The original file is never modified. Conversion uses a temporary input copy plus the MP4, so allow enough free disk space. Encoding can be slower than playback for large videos.
- Progress reflects processed video time, followed by MP4 finalization. You can cancel a running conversion.
- Completed files remain available for about one hour while the server is running. Inputs are deleted after conversion. Restarting clears the previous session's temporary files and job index.
- Desktop temporary files and `server.log` live in `~/Library/Application Support/MKV to MP4/`. Browser mode uses ignored `.conversions/` storage.
- Binds to loopback only and rejects foreign origins. Intended for personal local use.

## Verification

```sh
npm test
```

Tests use real FFmpeg fixtures to verify video copying (including unchanged video packet hashes), re-encoding, multiple audio tracks, downloadable MP4s, Unicode filenames, cancellation, invalid media, and request boundaries.
