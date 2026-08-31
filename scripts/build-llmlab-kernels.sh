#!/usr/bin/env bash
#
# 把 llmlab 的算子核编成 WebAssembly。
#
# 产物 public/llmlab/llmlab-kernels.wasm **进仓库**（几十 KB）。
# 和 opslab 那个 142MB 的 wasm 相反：那个只能 gitignore、由 CI 挂到 release，
# 代价是本机没装 Go 就改不了它。我们这个足够小，所以两全 ——
# 日常开发和外部 PR 都不需要装工具链，改算子的人才需要。
#
# CI 里 .github/workflows/release.yml 会用同一个钉死的 wasi-sdk 重建一遍，
# 断言与仓库里那份**字节一致**。所以这个脚本必须是可复现的：
#   - clang 版本钉死（WASI_SDK_VERSION）
#   - 不传任何带时间戳/路径的东西进产物
#   - 不用 -ffast-math（它会让浮点重结合，直接毁掉「两遍逐位一致」那条门槛）
#
# 用法：
#   bash scripts/build-llmlab-kernels.sh            # 用 .llmlab-build 下的 sdk，没有就下载
#   WASI_SDK=/path/to/wasi-sdk bash scripts/...     # 用现成的
#   bash scripts/build-llmlab-kernels.sh --check    # 只重建到临时目录并比对，不覆盖
set -euo pipefail

WASI_SDK_VERSION="${WASI_SDK_VERSION:-34.0}"
WASI_SDK_MAJOR="${WASI_SDK_VERSION%%.*}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="${WORK:-$ROOT/.llmlab-build}"
SRC="$ROOT/src/lib/llmlab/kernels"
OUT_DIR="$ROOT/public/llmlab"
OUT_NAME="llmlab-kernels.wasm"

CHECK=0
[ "${1:-}" = "--check" ] && CHECK=1

# ---------------------------------------------------------------- 工具链

if [ -z "${WASI_SDK:-}" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) ASSET="wasi-sdk-${WASI_SDK_VERSION}-arm64-macos" ;;
    Darwin-x86_64) ASSET="wasi-sdk-${WASI_SDK_VERSION}-x86_64-macos" ;;
    Linux-aarch64) ASSET="wasi-sdk-${WASI_SDK_VERSION}-arm64-linux" ;;
    Linux-x86_64) ASSET="wasi-sdk-${WASI_SDK_VERSION}-x86_64-linux" ;;
    *) echo "不认识的平台：$(uname -s)-$(uname -m)"; exit 1 ;;
  esac
  WASI_SDK="$WORK/$ASSET"
  if [ ! -x "$WASI_SDK/bin/clang" ]; then
    echo "→ 下载 wasi-sdk ${WASI_SDK_VERSION}（约 180MB，只需一次）"
    mkdir -p "$WORK"
    URL="https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_MAJOR}/${ASSET}.tar.gz"
    curl -fsSL -o "$WORK/${ASSET}.tar.gz" "$URL"
    tar xzf "$WORK/${ASSET}.tar.gz" -C "$WORK"
  fi
fi

CLANG="$WASI_SDK/bin/clang"
[ -x "$CLANG" ] || { echo "找不到 $CLANG —— 设 WASI_SDK 或让脚本自己下载"; exit 1; }

# ---------------------------------------------------------------- 编译

# --target=wasm32-unknown-unknown 而不是 wasip1：我们要一个**零 import** 的模块。
#   链上 wasi-libc 就会多出 fd_write 之类的 import，JS 那边得挨个 stub。
# -msimd128 是 f32 那条路径快 8 倍的来源（原型实测 5.0 → 42 GFLOP/s）。
# **没有 -ffast-math**：它允许浮点重结合，同一份代码两次编译、甚至同一次编译里
#   不同的内联点，结果都可能不同 —— 而「两遍逐位一致」是所有门槛的地基。
FLAGS=(
  --target=wasm32-unknown-unknown
  -O3
  -msimd128
  -mbulk-memory
  -nostdlib
  -ffreestanding
  -fno-builtin-memcpy
  -Wall -Wextra -Werror
  -Wno-unused-parameter
  -Wl,--no-entry
  -Wl,--export-all
  -Wl,--export-memory
  -Wl,--initial-memory=16777216
  -Wl,--stack-first
  -Wl,-z,stack-size=1048576
  -Wl,--strip-debug
)

mkdir -p "$OUT_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

"$CLANG" "${FLAGS[@]}" -o "$TMP/$OUT_NAME" "$SRC/kernels.c"

SIZE=$(wc -c < "$TMP/$OUT_NAME" | tr -d ' ')
echo "→ $OUT_NAME: $SIZE 字节（clang $("$CLANG" --version | head -1 | sed 's/.*version //;s/ .*//')）"

# 一个粗但有效的完整性检查：编出来只有几百字节说明基本全被优化掉了
if [ "$SIZE" -lt 4000 ]; then
  echo "::error::产物只有 $SIZE 字节 —— 看起来符号被裁光了"
  exit 1
fi

if [ "$CHECK" = "1" ]; then
  if [ ! -f "$OUT_DIR/$OUT_NAME" ]; then
    echo "::error::仓库里没有 $OUT_DIR/$OUT_NAME"
    exit 1
  fi
  if cmp -s "$TMP/$OUT_NAME" "$OUT_DIR/$OUT_NAME"; then
    echo "✓ 重建产物与仓库里那份字节一致"
  else
    echo "::error::重建产物与仓库里那份**不一致**。"
    echo "  改了 kernels 就要跑一遍 bash scripts/build-llmlab-kernels.sh 并把产物一起提交。"
    echo "  仓库: $(wc -c < "$OUT_DIR/$OUT_NAME" | tr -d ' ') 字节  重建: $SIZE 字节"
    exit 1
  fi
else
  cp "$TMP/$OUT_NAME" "$OUT_DIR/$OUT_NAME"
  echo "✓ 已写入 $OUT_DIR/$OUT_NAME"
fi
