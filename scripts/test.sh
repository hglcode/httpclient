#!/bin/bash
set -euo pipefail

# --- 颜色定义（兼容 tput 与 ANSI 回退）---
setup_colors() {
    # 如果输出不是终端，或用户设置了 NO_COLOR，则禁用颜色
    if [[ ! -t 1 ]] || [[ -n "${NO_COLOR:-}" ]]; then
        R='' G='' Y='' B='' NC=''
        return
    fi

    # 优先使用 tput
    if command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then
        R=$(tput setaf 1) G=$(tput setaf 2)
        Y=$(tput setaf 3) B=$(tput setaf 4)
        NC=$(tput sgr0)
    else
        # 回退到硬编码 ANSI 转义码
        # 注意：使用 $'...' 语法需要 bash，对于纯 POSIX sh 可改用 printf
        R=$'\033[0;31m' G=$'\033[0;32m'
        Y=$'\033[1;33m' B=$'\033[0;34m'
        NC=$'\033[0m'
    fi
}
setup_colors

debug() { printf "${B}[DEBUG]:${NC} %s\n" "$*"; }
info() { printf "${G}[INFO]:${NC} %s\n" "$*"; }
warn() { printf "${Y}[WARNNING]:${NC} %s\n" "$*" >&2; }
error() { printf "${R}[ERROR]:${NC} %s\n" "$*" >&2; }
fatal() { printf "${R}[FATAL]:${NC} %s\n" "$*" >&2; }
die() {
    error "$*"
    exit 1
}

need() {
    ngs=""
    for cmd in "$@"; do
        command -v "$cmd" >/dev/null 2>&1 || ngs="$ngs $cmd"
    done
    [ -z "$ngs" ] && return
    die "Not found commands: $ngs"
}

need bun node pnpm

info "======================================"
info "Environment:"
info "node: $(node --version 2>/dev/null)"
info "bun:  $(bun --version 2>/dev/null)"
info "pnpm: $(pnpm --version 2>/dev/null)"
info "======================================"

HERE=$(
    CDPATH=
    cd -- "$(dirname -- "$0")" && pwd -P
)
ROOT=$(cd -- "$HERE/.." && pwd -P)

# Test bun environment
test_bun() {
    cd "$ROOT"
    rm -rf node_modules
    bun up --latest
    bun oxlint --type-aware scripts src tests >/dev/null
    bun tsc --noEmit >/dev/null
    bun test >/dev/null
    bun run build >/dev/null
}

test_node() {
    cd "$ROOT"
    rm -rf node_modules
    pnpm up --latest
    pnpm approve-builds -y >/dev/null
    pnpm oxlint --type-aware scripts src tests >/dev/null
    pnpm tsc --noEmit >/dev/null
    pnpm test >/dev/null
    pnpm run build >/dev/null
}

(test_bun && info "bun test OK") || fatal "bun test NG"
(test_node && info "node test OK") || fatal "node test NG"
