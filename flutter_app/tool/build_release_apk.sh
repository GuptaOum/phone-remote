#!/usr/bin/env bash
# Build, check and publish the release APK. Run ON THE EC2 (never the PC):
#   ~/phone-remote/flutter_app/tool/build_release_apk.sh
# arm64-only (see android/app/build.gradle). Publishes to
# ~/phone-remote/downloads/phone-remote.apk, served at /phone-remote.apk.
set -euo pipefail
cd "$(dirname "$0")/.."
export ANDROID_HOME="${ANDROID_HOME:-$HOME/android-sdk}"
FLUTTER="${FLUTTER:-$HOME/flutter/bin/flutter}"

# Stop the Gradle daemon on exit so an SSH session running this can return.
trap '(cd android && ./gradlew --stop >/dev/null 2>&1) || true' EXIT

"$FLUTTER" build apk --release --target-platform android-arm64
bash tool/verify_release_apk.sh
cp build/app/outputs/flutter-apk/app-release.apk ../downloads/phone-remote.apk
ls -l ../downloads/phone-remote.apk
sha1sum ../downloads/phone-remote.apk
