Post-process game asset images: background removal, resize, compress, or the full pipeline.

## How to use

Run from the `math_dragons/` directory. The CLI is at `tools/asset_generator/cli.py`.

### Full pipeline (remove bg -> resize -> compress)
The most common workflow for raw AI-generated images:
```
python tools/asset_generator/cli.py post-process RAW_IMAGE -o FINAL_PATH -s WxH
```
Example:
```
python tools/asset_generator/cli.py post-process assets/raw/dragon.png -o assets/images/dragons/dragon.png -s 512x512
```

### Full pipeline with density variants (for UI elements)
```
python tools/asset_generator/cli.py post-process RAW_IMAGE -o FINAL_PATH -s WxH -d
```
Creates 1x, 1.5x, 2x, 3x, 4x variants in subdirectories.

### Skip background removal (for backgrounds/scenes)
```
python tools/asset_generator/cli.py post-process RAW_IMAGE -o FINAL_PATH -s WxH --keep-bg
```

### Individual steps

#### Remove background only
```
python tools/asset_generator/cli.py remove-bg INPUT_IMAGE
python tools/asset_generator/cli.py remove-bg INPUT_IMAGE -o OUTPUT_PATH
```

#### Resize only
```
python tools/asset_generator/cli.py resize INPUT_IMAGE -s WxH -o OUTPUT_DIR
python tools/asset_generator/cli.py resize INPUT_IMAGE -s 64x64 -o assets/images/ui/ -d 1.0,1.5,2.0,3.0,4.0
```

#### Compress PNGs only
```
python tools/asset_generator/cli.py compress INPUT_PATH
python tools/asset_generator/cli.py compress assets/images/ -r -q 80-95
```

### Options reference

**post-process:**
- `-o, --output` (required): Final asset path
- `-s, --size` (required): Target display size "WxH"
- `--keep-bg`: Skip AI background removal
- `-d, --densities`: Create 1.5x/2x/3x/4x Flutter density variants
- `-q, --quality`: pngquant quality range (default: "80-95")

**remove-bg:**
- `-o, --output`: Output path (default: overwrite input)

**resize:**
- `-s, --size` (required): Target size "WxH"
- `-o, --output-dir` (required): Output directory
- `-d, --densities`: Comma-separated multipliers (e.g. "1.0,1.5,2.0,3.0,4.0")
- `-f, --format`: "png" (default) or "webp"

**compress:**
- `-q, --quality`: pngquant range (default: "80-95")
- `-r, --recursive`: Process directory recursively

### Common asset sizes for Math Dragons
| Asset type | Size | Densities? |
|-----------|------|------------|
| Dragon evolution portraits | 512x512 | No |
| Hub companions | 256x256 | No |
| Game sprites | 48x48 or 64x64 | No |
| UI icons | 32x32 or 48x48 | Yes (1x-4x) |
| Game backgrounds | 1920x1080 | No |
| Hub environment | 256x256 | No |

### Dependencies
- **rembg**: AI background removal (installed via `pip install rembg[cpu]`)
- **Pillow**: Image resizing (installed via `pip install Pillow`)
- **pngquant**: PNG compression (install via `scoop install pngquant`)

## User request
$ARGUMENTS
