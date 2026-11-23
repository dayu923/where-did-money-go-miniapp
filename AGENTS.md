# Repository Guidelines

## Project Structure & Module Organization

This repository is currently empty. No source, test, or asset directories are present. Keep new code in clearly named directories such as `src/`, `tests/`, and `assets/`, and add a short README when introducing a runnable application or library. Group files by feature or responsibility, and keep generated output out of source directories.

## Build, Test, and Development Commands

No build system or package scripts are configured yet. When adding a toolchain, document its setup and exact commands here and in the README. Provide reproducible commands for local development, building, and running tests; use the repository's package manager or build tool consistently rather than mixing alternatives.

## Coding Style & Naming Conventions

Follow the conventions of the language and framework introduced by the project. Use consistent indentation, descriptive names, and the formatter or linter configured in the repository. Keep modules focused and avoid adding dependencies for functionality already available in the platform or existing project stack.

## Testing Guidelines

No test framework or tests exist yet. Add tests alongside each new feature or behavior change, using the framework's standard test discovery and naming patterns. Document the command contributors should run before submitting changes; include regression coverage for bug fixes.

## Commit & Pull Request Guidelines

No Git history is available to establish a commit message convention. Use short, imperative commit subjects (for example, `Add account import`) until the project adopts a convention. Pull requests should explain the change and its motivation, list relevant validation commands and results, link related issues when available, and include screenshots for visible UI changes.

## Security & Configuration

Do not commit credentials, tokens, or machine-specific configuration. Provide safe example configuration with secrets omitted, and describe required environment variables when adding them.
