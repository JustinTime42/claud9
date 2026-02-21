Check the status of generated assets vs. what's expected.

## How to use

Run from the `math_dragons/` directory. The CLI is at `tools/asset_generator/cli.py`.

### Scan all images
```
python tools/asset_generator/cli.py list-assets
```

### Scan a specific directory
```
python tools/asset_generator/cli.py list-assets --dir assets/images/dragons
```

### Compare against a manifest
```
python tools/asset_generator/cli.py list-assets --manifest assets/manifest.json
```

### Options
- `--dir`: Directory to scan (default: `assets/images`). Finds all `*.png`, `*.jpg`, `*.webp` recursively.
- `--manifest`: Path to manifest.json for expected-vs-found comparison.

### Output
Returns JSON with:
- `found`: Number of assets found (matching manifest if provided)
- `missing`: Number of expected assets not found
- `total`: Total expected assets
- `extra`: Assets found but not in manifest
- `found_files`: List of found file paths
- `missing_files`: List of missing file paths

### Quick manual check
You can also just use file tools directly:
- `Glob` with `assets/images/**/*.png` to list all image assets
- `Glob` with `assets/audio/**/*` to list all audio assets
- Check `pubspec.yaml` for declared asset directories

## User request
$ARGUMENTS
