Generate game asset images using OpenAI GPT-Image-1.

## How to use

Run from the `math_dragons/` directory. The CLI is at `tools/asset_generator/cli.py`.

### Basic generation (transparent background, high quality)
```
python tools/asset_generator/cli.py image "PROMPT" -o OUTPUT_PATH
```

### With style reference images (for visual consistency)
```
python tools/asset_generator/cli.py image "PROMPT" -o OUTPUT_PATH -r assets/style_bible/approved/ref1.png assets/style_bible/approved/ref2.png
```

### Multiple variations
```
python tools/asset_generator/cli.py image "PROMPT" -o OUTPUT_PATH -v 3
```

### Options
- `-o, --output` (required): Output path relative to math_dragons/ (e.g. `assets/images/dragons/fire.png`)
- `-r, --style-refs`: 1-5 style bible reference images for visual consistency
- `-s, --size`: `1024x1024` (default), `1024x1536`, `1536x1024`, or `auto`
- `--opaque`: Use opaque background instead of transparent
- `-q, --quality`: `low`, `medium`, or `high` (default: high)
- `-v, --variations`: Number of variations 1-10 (default: 1). Creates `_v1.png`, `_v2.png`, etc.

### Style Bible Candidates
To generate style exploration candidates for the style bible:
```
python tools/asset_generator/cli.py style-candidates "PROMPT" -n 4 -o assets/style_bible/candidates
```
Options: `-n` count (1-10), `-o` output dir, `-q` quality (default: medium).

## Cost
- ~$0.10/image (medium), ~$0.20/image (high quality)
- Style ref images use the edit endpoint (~$0.15-0.25/image)

## Environment
Requires `OPENAI_API_KEY` in `tools/asset_generator/.env`.

## User request
$ARGUMENTS
