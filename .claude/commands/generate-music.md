Generate background music for Math Dragons.

## Available approaches

### Option 1: ElevenLabs SFX (ambient loops)
The existing ElevenLabs integration can generate short ambient loops suitable for background music:
```
python tools/asset_generator/cli.py sfx "DESCRIPTION" -o OUTPUT_PATH -d 30 --loop --prompt-influence 0.5
```
Best for: ambient pads, atmospheric loops, simple background textures. Limited to 30s max.

### Option 2: Suno API (full music tracks)
For actual melodic background music, use the Suno API directly via curl:
```bash
curl -X POST "https://apibox.erweima.ai/api/v1/generate" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SUNO_API_KEY" \
  -d '{
    "prompt": "DESCRIPTION",
    "customMode": true,
    "instrumental": true,
    "title": "TRACK_NAME",
    "style": "GENRE TAGS",
    "waitAudio": false
  }'
```
Then poll the task ID to get the download URL. Best for: full melodic tracks, theme songs, level music.

### Option 3: Download from free libraries
For production-ready royalty-free music:
- **Kenney.nl** (CC0): https://kenney.nl/assets?q=music
- **OpenGameArt**: https://opengameart.org/art-search-advanced?field_art_type_tid=12
- **Pixabay Music** (free license): https://pixabay.com/music/

### Good prompt patterns for game music
- "Cheerful fantasy adventure theme, orchestral, suitable for a children's math game, upbeat and encouraging"
- "Calm mysterious puzzle music, soft piano and strings, magical atmosphere"
- "Exciting fast-paced arcade music, chiptune influenced, energetic dragon theme"
- "Gentle reward fanfare, short triumphant melody, brass and bells"
- "Ambient dragon lair soundscape, deep low drones, occasional magical sparkles"

### Output format for Flame Audio
Background music should be:
- **Format**: MP3 (Flame audioplayers supports MP3 directly for music)
- **Sample rate**: 44.1 kHz
- **Channels**: Stereo
- **Duration**: 30-120 seconds for loops

### Music needed for Math Dragons
| Track | Style | Duration | Loop? |
|-------|-------|----------|-------|
| Hub theme | Cheerful fantasy, orchestral | 60-90s | Yes |
| Fire Trail | Fast-paced, exciting | 60s | Yes |
| Dragon Runes | Calm puzzle, mysterious | 60s | Yes |
| Dragon's Feast | Arcade energy, playful | 60s | Yes |
| Dragon Eggs | Gentle, nurturing | 60s | Yes |
| Victory fanfare | Triumphant, short | 5-10s | No |
| Game over | Sympathetic, encouraging | 5-10s | No |

## User request
$ARGUMENTS
