Generate sound effects using ElevenLabs text-to-sound-effects API.

## How to use

Run from the `math_dragons/` directory. The CLI is at `tools/asset_generator/cli.py`.

### Basic generation
```
python tools/asset_generator/cli.py sfx "DESCRIPTION" -o OUTPUT_PATH
```

### With duration and looping
```
python tools/asset_generator/cli.py sfx "DESCRIPTION" -o OUTPUT_PATH -d 2.0 --loop
```

### Options
- `-o, --output` (required): Output path relative to math_dragons/ (e.g. `assets/audio/sfx/coin_collect.mp3`)
- `-d, --duration`: Duration in seconds (0.5-30). Omit for auto-length.
- `--loop`: Create a seamless loop (good for ambient sounds)
- `--prompt-influence`: How closely to follow the description, 0.0-1.0 (default: 0.3). Higher = more literal.

### Output format
MP3 at 44.1 kHz, 128 kbps. For Flame Audio (which needs WAV), convert afterwards:
```
ffmpeg -i input.mp3 -ar 44100 -ac 1 -sample_fmt s16 output.wav
```

### Good prompt patterns for game SFX
- "Short magical chime, bright and rewarding, suitable for a children's game"
- "Soft whoosh sound, quick, like dragon wings flapping once"
- "Crunchy coin collect sound, 8-bit inspired, cheerful"
- "Deep rumbling growl, medium length, fantastical dragon sound"
- "Gentle bubbling potion sound, mystical, short"

## Cost
~$5/month (ElevenLabs Starter plan) for 15+ sound effects.

## Environment
Requires `ELEVENLABS_API_KEY` in `tools/asset_generator/.env`.

## User request
$ARGUMENTS
