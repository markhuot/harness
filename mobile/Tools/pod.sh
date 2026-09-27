#!/bin/bash
# Run CocoaPods ≥ 1.15 (React Native 0.86 podspecs need it). The system `pod` on this Mac is
# 1.11 on macOS's Ruby 2.6, so fall back to a CocoaPods installed for Homebrew's Ruby in its own
# gem home:  GEM_HOME=~/.local/share/cocoapods-ruby4 /opt/homebrew/opt/ruby/bin/gem install cocoapods
set -euo pipefail
export LANG="${LANG:-en_US.UTF-8}"
if command -v pod >/dev/null 2>&1; then
  v="$(pod --version 2>/dev/null || echo 0)"
  major="${v%%.*}"; rest="${v#*.}"; minor="${rest%%.*}"
  if [ "$major" -gt 1 ] 2>/dev/null || { [ "$major" -eq 1 ] && [ "$minor" -ge 15 ]; } 2>/dev/null; then
    exec pod "$@"
  fi
fi
GH="${COCOAPODS_GEM_HOME:-$HOME/.local/share/cocoapods-ruby4}"
RUBY="${COCOAPODS_RUBY:-/opt/homebrew/opt/ruby/bin/ruby}"
if [ ! -x "$GH/bin/pod" ] || [ ! -x "$RUBY" ]; then
  echo "CocoaPods >= 1.15 not found. Install it with:" >&2
  echo "  GEM_HOME=$GH /opt/homebrew/opt/ruby/bin/gem install cocoapods" >&2
  exit 1
fi
GEM_HOME="$GH" GEM_PATH="$GH" exec "$RUBY" "$GH/bin/pod" "$@"
