#!/bin/sh
set -e

IMAGE_NAME="${IMAGE_NAME:-ghcr.io/giwi/giwisoft-scenarii}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

podman build \
  --platform linux/amd64 \
  -t "${IMAGE_NAME}:${IMAGE_TAG}" \
  -f Containerfile \
  .

echo ""
echo "Image built: ${IMAGE_NAME}:${IMAGE_TAG}"
echo ""
echo "Run with:"
echo "  mkdir -p scenarios db"
echo "  podman run -d \\"
echo "    --name scenarii \\"
echo "    -p 3000:3000 \\"
echo "    -v \$(pwd)/scenarios:/scenarios:z \\"
echo "    -v \$(pwd)/db:/app/db:z \\"
echo "    ${IMAGE_NAME}:${IMAGE_TAG}"
