.DEFAULT_GOAL := help
SHELL := /bin/bash

PNPM ?= pnpm

.PHONY: help deps build build-native install update test test-native clean

help:
	@echo "Available make commands:"
	@echo "  make build         - Build TypeScript packages"
	@echo "  make install       - Full pack and install plugin to DeepSeek Harness (~/.dsh)"
	@echo "  make update        - Quick incremental update to DeepSeek Harness (~/.dsh)"
	@echo "  make deps          - Install project dependencies using pnpm"
	@echo "  make build-native  - Build macOS native NuPhy Swift daemon"
	@echo "  make test          - Run test suite"
	@echo "  make test-native   - Run Swift native daemon self-test"
	@echo "  make clean         - Clean build artifacts and caches"

deps:
	@echo "==> Installing dependencies..."
	@$(PNPM) install

build:
	@echo "==> Building TypeScript packages..."
	@$(PNPM) build

build-native:
	@echo "==> Building Swift native daemon..."
	@$(PNPM) build:native

install:
	@echo "==> Running full installation to DeepSeek Harness..."
	@./scripts/install-to-dsh.sh $(ARGS)

update:
	@echo "==> Running quick incremental update to DeepSeek Harness..."
	@./scripts/update-to-dsh.sh $(ARGS)

test:
	@echo "==> Running tests..."
	@$(PNPM) test

test-native:
	@echo "==> Running native driver self-test..."
	@$(PNPM) test:native

clean:
	@echo "==> Cleaning build artifacts..."
	@rm -rf packages/*/dist packages/*/*.tsbuildinfo packages/daemon/bin/keyboard-daemon .cache/swift packages/*/*.tgz
	@echo "==> Clean complete."
