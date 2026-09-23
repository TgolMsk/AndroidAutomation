#!/bin/sh
set -eu

build_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary_dir=$(mktemp -d)
trap 'rm -rf "$temporary_dir"' EXIT

source_png="$build_dir/icon.png"
iconset="$temporary_dir/AVDM.iconset"
mkdir "$iconset"

if [ ! -f "$source_png" ]; then
  echo "Missing 1024px application icon source: $source_png" >&2
  exit 1
fi

width=$(sips -g pixelWidth "$source_png" | awk '/pixelWidth:/ { print $2 }')
height=$(sips -g pixelHeight "$source_png" | awk '/pixelHeight:/ { print $2 }')
if [ "$width" != 1024 ] || [ "$height" != 1024 ]; then
  echo "Application icon source must be 1024x1024 PNG (got ${width}x${height})" >&2
  exit 1
fi

for size in 16 32 128 256 512; do
  double_size=$((size * 2))
  sips -z "$size" "$size" "$source_png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z "$double_size" "$double_size" "$source_png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done

iconutil -c icns -o "$temporary_dir/icon.icns" "$iconset"
mv "$temporary_dir/icon.icns" "$build_dir/icon.icns"
