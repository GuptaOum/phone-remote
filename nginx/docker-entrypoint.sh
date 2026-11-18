#!/bin/sh
set -e

# Public hostname whose Let's Encrypt cert lives in /etc/letsencrypt/live/<DOMAIN>.
# Set via docker-compose (DOMAIN=...); changing servers only needs a new value there.
DOMAIN="${DOMAIN:-localhost}"
CERT_DIR="/etc/letsencrypt/live/$DOMAIN"

CONFS="/etc/nginx/conf.d/default.conf /etc/nginx/stream.d/stream.conf"
sed -i "s#__DOMAIN__#$DOMAIN#g" $CONFS

if [ ! -f "$CERT_DIR/fullchain.pem" ] || [ ! -f "$CERT_DIR/privkey.pem" ]; then
    echo "⚠️  SSL certificates not found at $CERT_DIR. Creating fallback self-signed cert..."
    CERT_DIR="/etc/nginx/selfsigned/$DOMAIN"
    mkdir -p "$CERT_DIR"
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$CERT_DIR/privkey.pem" \
        -out "$CERT_DIR/fullchain.pem" \
        -subj "/CN=$DOMAIN"
    sed -i "s#/etc/letsencrypt/live/$DOMAIN/#$CERT_DIR/#g" $CONFS
    echo "✅ Fallback self-signed certificate created."
fi

exec "$@"
