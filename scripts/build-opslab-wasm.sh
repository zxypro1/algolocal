#!/usr/bin/env bash
#
# 把真 kubectl 编译成 WebAssembly，供 opslab 工作台在浏览器里运行。
#
# 为什么要打补丁：kubectl 有几处是 `//go:build !windows`，js/wasm 也匹配这个条件，
# 于是终端 ioctl、信号、umask、syscall.Exec 这些在浏览器里不存在的东西被编了进来。
# patches/ 下的补丁只做两件事：把这些文件排除在 js 之外，再补一份 js 版空实现。
# 另外给 client-go 换了个走 fetch 的 RoundTripper —— 浏览器里没有 socket。
#
# 产物不进仓库（约 115MB），CI 里单独一条 job 构建后挂到 release。
set -euo pipefail

K8S_VERSION="${K8S_VERSION:-v0.36.0}"
OUT_DIR="${OUT_DIR:-public/opslab}"
WORK="${WORK:-.opslab-build}"

command -v go >/dev/null || { echo "需要 Go 工具链（见 design/opslab.md）"; exit 1; }

mkdir -p "$WORK" "$OUT_DIR"
cd "$WORK"

if [ ! -f go.mod ]; then
  cat > go.mod <<EOF
module opslab/kubectlwasm

go 1.26.0
EOF
  cat > main.go <<'EOF'
package main

import (
	"os"

	"k8s.io/kubectl/pkg/cmd"
)

func main() {
	if err := cmd.NewDefaultKubectlCommand().Execute(); err != nil {
		os.Exit(1)
	}
}
EOF
  go get "k8s.io/kubectl@${K8S_VERSION}"
  go mod tidy
fi

go mod vendor
bash ../scripts/opslab-wasm-patches.sh vendor

GOOS=js GOARCH=wasm go build -mod=vendor -trimpath -ldflags="-s -w" -o "../$OUT_DIR/kubectl.wasm" .
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "../$OUT_DIR/wasm_exec.js" 2>/dev/null \
  || cp "$(go env GOROOT)/misc/wasm/wasm_exec.js" "../$OUT_DIR/wasm_exec.js"

cd ..
ls -lh "$OUT_DIR/kubectl.wasm" | awk '{print "kubectl.wasm:", $5}'
