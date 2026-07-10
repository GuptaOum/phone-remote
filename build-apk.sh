#!/bin/bash
# Build the release APK on EC2 and download it.
# Usage (from repo root, in Git Bash):  ./build-apk.sh
set -e

KEY=~/.ssh/phone-remote.pem
HOST=ubuntu@3.6.239.48
OUT=/c/Users/hp/Downloads/app-release.apk

echo "[1/4] Packaging source..."
tar --exclude=build --exclude=.dart_tool --exclude=.gradle --exclude=.kotlin \
    --exclude=.flutter-plugins-dependencies \
    -czf /c/Users/hp/AppData/Local/Temp/flutter_app.tgz flutter_app

echo "[2/4] Uploading to EC2..."
scp -q -i "$KEY" -o StrictHostKeyChecking=no /c/Users/hp/AppData/Local/Temp/flutter_app.tgz "$HOST":

echo "[3/4] Building on EC2 (warm cache ≈ 5-10 min)..."
ssh -i "$KEY" -o StrictHostKeyChecking=no "$HOST" '
  set -e
  tar xzf flutter_app.tgz -C ~/phone-remote
  rm -f ~/phone-remote/flutter_app/android/local.properties
  cd ~/phone-remote/flutter_app
  ~/flutter/bin/flutter build apk --release 2>&1 | tail -3
'

echo "[4/4] Downloading APK..."
scp -q -i "$KEY" -o StrictHostKeyChecking=no \
    "$HOST":phone-remote/flutter_app/build/app/outputs/flutter-apk/app-release.apk "$OUT"

echo "DONE → $OUT"
