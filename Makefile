IMAGE_NAME ?= ghcr.io/giwi/giwisoft-scenarii
GIT_TAG := $(shell git describe --tags --exact-match 2>/dev/null || echo latest)
IMAGE_TAG ?= $(GIT_TAG)

.PHONY: build build-arm64 build-multi test lint clean tag

build:
	IMAGE_TAG=$(IMAGE_TAG) ./build-container.sh

build-arm64:
	PLATFORM=linux/arm64 IMAGE_TAG=$(IMAGE_TAG) ./build-container.sh

build-multi:
	PLATFORM=multi IMAGE_TAG=$(IMAGE_TAG) ./build-container.sh

# Tag and push a release (e.g. make tag VERSION=v1.0.1)
tag:
	git tag -a $(VERSION) -m "Release $(VERSION)"
	git push origin $(VERSION)

test:
	npm test

lint:
	npm run lint

clean:
	rm -rf dist dist-test frontend/dist
