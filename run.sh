#!/usr/bin/env bash
exec "$(cd "${ARMOR_COMMON_DIR:-$(dirname "${BASH_SOURCE[0]}")/../ARMOR-COMMON}/scripts" && pwd)/armor-project.sh" run "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
