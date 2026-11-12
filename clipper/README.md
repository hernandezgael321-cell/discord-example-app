# Auto-clipper

Cuts highlight clips out of a long video or stream VOD. It finds the moments
where the audio suddenly gets louder than usual (yelling, crowd noise, big
plays) and exports each one as a short clip. By default each clip is a
vertical 9:16 video ready for Shorts, TikTok or Reels.

Requires `ffmpeg` and `ffprobe` on your PATH. No npm installs needed.

```bash
npm run clip -- my_stream.mp4                 # 5 vertical 30s clips -> clips/my_stream/
npm run clip -- my_stream.mp4 --dry-run       # just list the moments it found
npm run clip -- my_stream.mp4 -n 10 -l 45     # 10 clips, 45s each
npm run clip -- my_stream.mp4 -v crop         # center-crop to 9:16 instead of blur background
npm run clip -- my_stream.mp4 -v none         # keep the original aspect ratio
```

| Option | Default | What it does |
|---|---|---|
| `-n, --count` | 5 | How many clips to make |
| `-l, --length` | 30 | Clip length in seconds |
| `--lead` | 0.7 | Where the peak sits in the clip (0.7 = 70% build-up, 30% payoff) |
| `--min-gap` | = length | Minimum seconds between two clip peaks |
| `--window` | 60 | How much surrounding audio counts as "normal" for comparison |
| `-v, --vertical` | blur | `blur`, `crop` or `none` |
| `-o, --out` | `clips/<name>` | Output folder |

Each run also writes a `clips.json` file listing each clip's timestamps and score.

**How it scores moments:** it measures EBU R128 momentary loudness for every
second, smooths it over 3 seconds, and ranks each second by how much louder
it is than the median of the minute around it. A small bonus goes to moments
that are loud for the whole video. Clips are chosen so they don't overlap.
