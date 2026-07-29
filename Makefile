# Convenience targets. Everything here also works as a plain pnpm/uv command.
.DEFAULT_GOAL := help
.PHONY: help bootstrap check typecheck lint fmt test test-unit test-integration \
        python-test python-lint doctor clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

bootstrap: ## Install every dependency (idempotent)
	./scripts/bootstrap

check: typecheck lint test python-lint python-test ## Run everything CI runs

typecheck: ## TypeScript 7 typecheck
	pnpm run typecheck

lint: ## Biome lint and format check
	pnpm run lint

fmt: ## Apply Biome fixes and formatting
	pnpm run lint:fix

test: ## All Node tests
	pnpm run test

test-unit: ## Node unit tests only
	pnpm run test:unit

test-integration: ## Node integration tests (real ffmpeg, synthetic audio)
	pnpm run test:integration

python-test: ## Python worker tests
	cd python/openmurmur_audio && uv run pytest -v

python-lint: ## Python lint, format check and strict typecheck
	cd python/openmurmur_audio && uv run ruff check .
	cd python/openmurmur_audio && uv run ruff format --check .
	cd python/openmurmur_audio && uv run mypy src

doctor: ## Check the local environment
	node src/cli/main.ts doctor

clean: ## Remove build and dependency artifacts (never touches your data)
	rm -rf node_modules python/openmurmur_audio/.venv
	@echo "Your audio, transcripts and database in ~/Library/Application Support/OpenMurmur are untouched."
