#!/bin/sh
set -e

GIT_TAG="$(git describe --tags --exact-match 2>/dev/null || true)"
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

IMAGE_NAME="${IMAGE_NAME:-ghcr.io/giwi/giwisoft-scenarii}"
IMAGE_TAG="${IMAGE_TAG:-${GIT_TAG:-latest}}"
PLATFORM="${PLATFORM:-linux/amd64}"

if [ "${PLATFORM}" = "multi" ]; then
  # Multi-arch: requires docker buildx or podman with multi-arch support
  TAGS="-t ${IMAGE_NAME}:${IMAGE_TAG}"
  if [ "${IMAGE_TAG}" != "${GIT_SHA}" ]; then
    TAGS="${TAGS} -t ${IMAGE_NAME}:${GIT_SHA}"
  fi
  if command -v docker >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    docker buildx build \
      --platform linux/amd64,linux/arm64 \
      ${TAGS} \
      -f Containerfile \
      --push \
      .
  elif command -v podman >/dev/null 2>&1; then
    # podman multi-arch with manifest
    if [ "${IMAGE_TAG}" != "${GIT_SHA}" ]; then
      podman build \
        --platform linux/amd64,linux/arm64 \
        -t "${IMAGE_NAME}:${IMAGE_TAG}" \
        -f Containerfile \
        --manifest "${IMAGE_NAME}:${IMAGE_TAG}" \
        .
      podman tag "localhost/${IMAGE_NAME}:${IMAGE_TAG}" "${IMAGE_NAME}:${GIT_SHA}"
    else
      podman build \
        --platform linux/amd64,linux/arm64 \
        -t "${IMAGE_NAME}:${IMAGE_TAG}" \
        -f Containerfile \
        --manifest "${IMAGE_NAME}:${IMAGE_TAG}" \
        .
    fi
  else
    echo "No container runtime found" >&2
    exit 1
  fi
  echo ""
  echo "Multi-arch image built: ${IMAGE_NAME}:${IMAGE_TAG} (linux/amd64, linux/arm64)"
else
  if command -v podman >/dev/null 2>&1; then
    podman build \
      --platform "${PLATFORM}" \
      -t "${IMAGE_NAME}:${IMAGE_TAG}" \
      -f Containerfile \
      .
  elif command -v docker >/dev/null 2>&1; then
    docker build \
      --platform "${PLATFORM}" \
      -t "${IMAGE_NAME}:${IMAGE_TAG}" \
      -f Containerfile \
      .
  else
    echo "No container runtime found" >&2
    exit 1
  fi
  echo ""
  echo "Image built: ${IMAGE_NAME}:${IMAGE_TAG} (${PLATFORM})"
fi

echo ""
echo "Run with:"
echo "  mkdir -p scenarios db"
echo "  podman run -d \\"
echo "    --name scenarii \\"
echo "    -p 3000:3000 \\"
echo "    -v \$(pwd)/scenarios:/scenarios:z \\"
echo "    -v \$(pwd)/db:/app/db:z \\"
echo "    ${IMAGE_NAME}:${IMAGE_TAG}"
