#!/usr/bin/env bash
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/../ARMOR-COMMON/scripts" && pwd)/armor-project.sh" run "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
