#!/usr/bin/env bash
# Regression check for a built APK — run after `flutter build apk --release`.
#
# BUG-R1 (2026-11-18): R8 renamed/stripped libwebrtc's Java classes in the
# release build. libwebrtc's native code looks them up by exact name over JNI,
# so the moment a browser started WebRTC the app aborted (uncatchable native
# crash) and the phone dropped off right after "Start now" on the screen-cast
# prompt. Fix: keep rules in android/app/proguard-rules.pro. This check fails
# if those classes go missing again.
#
# BUG-R2 (same day): with org.webrtc kept, it still aborted (SIGTRAP inside
# libjingle_peerconnection_so JNI_OnLoad) because the library's JNI bridge
# lives in a second package, org.jni_zero, which R8 had stripped entirely.
#
# Usage: tool/verify_release_apk.sh [path/to/app-release.apk]
set -euo pipefail

APK="${1:-build/app/outputs/flutter-apk/app-release.apk}"
[ -f "$APK" ] || { echo "FAIL: APK not found: $APK"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
unzip -q -o "$APK" 'classes*.dex' -d "$TMP"

# Classes the native library resolves by name (FindClass / GetMethodID).
REQUIRED=(
  'Lorg/webrtc/VideoFrame;'
  'Lorg/webrtc/VideoFrame$Buffer;'
  'Lorg/webrtc/IceCandidate;'
  'Lorg/webrtc/SessionDescription;'
  'Lorg/webrtc/PeerConnection$Observer;'
  'Lorg/webrtc/RtpParameters$Encoding;'
  'Lorg/webrtc/NativeLibrary;'
  'Lorg/webrtc/JniHelper;'
  'Lorg/webrtc/VideoEncoderFactory;'
  'Lorg/webrtc/CapturerObserver;'
  # BUG-R2: libwebrtc's JNI_OnLoad initialises the jni_zero bridge first.
  'Lorg/jni_zero/JniInit;'
  'Lorg/jni_zero/JniUtil;'
)

fail=0
for cls in "${REQUIRED[@]}"; do
  # grep the files directly: `cat | grep -q` + pipefail reports SIGPIPE as a miss.
  if grep -aqF -- "$cls" "$TMP"/classes*.dex; then
    echo "ok    $cls"
  else
    echo "FAIL  $cls missing (R8 stripped/renamed it — check proguard-rules.pro)"
    fail=1
  fi
done

# Release APKs are arm64-only (build.gradle abiFilters). Every native lib
# Flutter and WebRTC need must be there for arm64, and no other ABI may sneak
# back in (a half-populated 32-bit folder would crash on 32-bit phones).
LISTING="$(unzip -l "$APK")"
for lib in libjingle_peerconnection_so.so libflutter.so libapp.so; do
  if [[ "$LISTING" == *"lib/arm64-v8a/$lib"* ]]; then
    echo "ok    lib/arm64-v8a/$lib"
  else
    echo "FAIL  lib/arm64-v8a/$lib missing"
    fail=1
  fi
done
for abi in armeabi-v7a x86 x86_64; do
  if [[ "$LISTING" == *"lib/$abi/"* ]]; then
    echo "FAIL  lib/$abi/ present — release should be arm64-only"
    fail=1
  fi
done

[ "$fail" -eq 0 ] && echo "PASS: release APK keeps everything WebRTC needs" || { echo "FAILED"; exit 1; }
