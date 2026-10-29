#!/bin/sh
set -e

CERT_DIR="/etc/letsencrypt/live/3-6-239-48.sslip.io"

if [ ! -f "$CERT_DIR/fullchain.pem" ] || [ ! -f "$CERT_DIR/privkey.pem" ]; then
    echo "⚠️  SSL certificates not found at $CERT_DIR. Creating fallback self-signed cert..."
    mkdir -p "$CERT_DIR"
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$CERT_DIR/privkey.pem" \
        -out "$CERT_DIR/fullchain.pem" \
        -subj "/CN=3-6-239-48.sslip.io"
    echo "✅ Fallback self-signed certificate created successfully."
fi

exec "$@"
