#!/bin/sh
# Copies the mod into Herdr's mods folder and checks it. Never overwrites a different mod's files.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
dest="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods/gh-status"
mkdir -p "$dest"
cp "$here"/mods/gh-status/* "$dest"/
herdr-app check "$dest"
