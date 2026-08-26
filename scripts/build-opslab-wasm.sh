#!/usr/bin/env bash
#
# 把真 CLI 编译成 WebAssembly，供 opslab 工作台在浏览器里运行。
#
# 一个二进制，多个 CLI（busybox 式，按 argv[0] 分发）。原因是量出来的：
# client-go 本身就有 5.5MB（brotli）的地板，每个 CLI 单独编就要各付一次；
# 编进同一个二进制之后，kubectl 之上再加 helm 只多了 1.12MB。
# 详见 design/opslab-spike.md 第二节。
#
# 为什么要打补丁：上游有几处写的是 `//go:build !windows`，js/wasm 也匹配这个条件，
# 于是终端 ioctl、信号、umask、syscall.Exec 这些在浏览器里不存在的东西被编了进来。
# scripts/opslab-wasm-patches.sh 只做两件事：把这些文件排除在 js 之外，
# 再补一份 js 版空实现。另外给 client-go 换了个走 fetch 的 RoundTripper。
#
# 产物不进仓库（约 130MB），CI 里单独一条 job 构建后挂到 release。
set -euo pipefail

K8S_VERSION="${K8S_VERSION:-v0.36.0}"
HELM_VERSION="${HELM_VERSION:-v4.2.4}"
OUT_DIR="${OUT_DIR:-public/opslab}"
WORK="${WORK:-.opslab-build}"
OUT_NAME="${OUT_NAME:-opslab-cli.wasm}"

command -v go >/dev/null || { echo "需要 Go 工具链（见 design/opslab.md）"; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT/$WORK" "$ROOT/$OUT_DIR"

cat > "$ROOT/$WORK/main.go" <<'MAIN_EOF'
// opslab 的多合一 CLI。
//
// 按 argv[0] 决定这一次当哪个命令跑 —— 宿主把 `kubectl` / `helm` 作为 argv[0]
// 传进来。这样一份 client-go 被所有 CLI 共用，而不是每个 CLI 各背一份。
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	helmcmd "helm.sh/helm/v4/pkg/cmd"
	kubectlcmd "k8s.io/kubectl/pkg/cmd"
)

var applets = []string{"kubectl", "helm"}

func main() {
	switch appletName() {
	case "kubectl":
		if err := kubectlcmd.NewDefaultKubectlCommand().Execute(); err != nil {
			os.Exit(1)
		}

	case "helm":
		root, err := helmcmd.NewRootCmd(os.Stdout, os.Args[1:], helmcmd.SetupLogging)
		if err != nil {
			fmt.Fprintln(os.Stderr, "Error:", err)
			os.Exit(1)
		}
		root.SetArgs(os.Args[1:])
		if err := root.Execute(); err != nil {
			fmt.Fprintln(os.Stderr, "Error:", err)
			os.Exit(1)
		}

	// 宿主启动时问一句「这个二进制里有哪些 CLI」，免得两边的清单各写一份对不上
	case "opslab-cli", "":
		fmt.Println(strings.Join(applets, "\n"))

	default:
		fmt.Fprintf(os.Stderr, "opslab-cli: no applet named %q (have: %s)\n",
			appletName(), strings.Join(applets, ", "))
		os.Exit(127)
	}
}

func appletName() string {
	if len(os.Args) == 0 {
		return ""
	}
	return strings.TrimSuffix(filepath.Base(os.Args[0]), ".wasm")
}
MAIN_EOF

if [ ! -f "$ROOT/$WORK/go.mod" ]; then
  cat > "$ROOT/$WORK/go.mod" <<EOF
module opslab/cli

go 1.26.0
EOF
fi

go -C "$ROOT/$WORK" get "k8s.io/kubectl@${K8S_VERSION}"
go -C "$ROOT/$WORK" get "helm.sh/helm/v4@${HELM_VERSION}"
go -C "$ROOT/$WORK" mod tidy
go -C "$ROOT/$WORK" mod vendor
bash "$ROOT/scripts/opslab-wasm-patches.sh" "$ROOT/$WORK/vendor"

# 版本号靠 ldflags 注入，和上游发行版一样 —— 不注入的话 `kubectl version`
# 打的是 `v0.0.0-master+$Format:%H$`，学员一眼就看出这不是真东西。
# buildDate 写死，保证同样的输入构建出同样的产物。
KUBE_SEMVER="${K8S_VERSION#v0.}"
LDFLAGS="-s -w"
LDFLAGS="$LDFLAGS -X k8s.io/client-go/pkg/version.gitVersion=v1.${KUBE_SEMVER}"
LDFLAGS="$LDFLAGS -X k8s.io/client-go/pkg/version.gitMajor=1"
LDFLAGS="$LDFLAGS -X k8s.io/client-go/pkg/version.gitMinor=${KUBE_SEMVER%%.*}"
LDFLAGS="$LDFLAGS -X k8s.io/client-go/pkg/version.gitCommit=opslab"
LDFLAGS="$LDFLAGS -X k8s.io/client-go/pkg/version.gitTreeState=clean"
LDFLAGS="$LDFLAGS -X k8s.io/client-go/pkg/version.buildDate=2026-01-01T00:00:00Z"
LDFLAGS="$LDFLAGS -X k8s.io/component-base/version.gitVersion=v1.${KUBE_SEMVER}"
LDFLAGS="$LDFLAGS -X k8s.io/component-base/version.gitMajor=1"
LDFLAGS="$LDFLAGS -X k8s.io/component-base/version.gitMinor=${KUBE_SEMVER%%.*}"
LDFLAGS="$LDFLAGS -X k8s.io/component-base/version.buildDate=2026-01-01T00:00:00Z"
LDFLAGS="$LDFLAGS -X helm.sh/helm/v4/internal/version.version=${HELM_VERSION}"
LDFLAGS="$LDFLAGS -X helm.sh/helm/v4/internal/version.gitCommit=opslab"

GOOS=js GOARCH=wasm go -C "$ROOT/$WORK" build \
  -mod=vendor -trimpath -ldflags="$LDFLAGS" -o "$ROOT/$OUT_DIR/$OUT_NAME" .

cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$ROOT/$OUT_DIR/wasm_exec.js" 2>/dev/null \
  || cp "$(go env GOROOT)/misc/wasm/wasm_exec.js" "$ROOT/$OUT_DIR/wasm_exec.js"

# Go 的 time.Now() 在 js/wasm 里读的是宿主的 Date。虚拟世界里这会让
# `helm list` 的 UPDATED 列、各种时间戳每次都不一样，回放就对不上了。
# 把**墙钟**接到宿主提供的虚拟时钟上（不提供时仍然用真时间）。
# 单调时钟保持真实时间 —— 原因见下面那段注释。
python3 - "$ROOT/$OUT_DIR/wasm_exec.js" <<'PYEOF'
import sys
path = sys.argv[1]
source = open(path).read()
old_wall = '''					const msec = (new Date).getTime();'''
new_wall = '''					// opslab: 虚拟时钟优先，回放才逐字节一致
					const msec = (globalThis.__opslabNow ? globalThis.__opslabNow() : (new Date).getTime());'''
old_nano = '''						setInt64(sp + 8, (timeOrigin + performance.now()) * 1000000);'''
# 单调时钟**不能**跟着虚拟时钟走。
# Go 的 context.WithTimeout、time.After、各种重试循环用的都是单调时钟；
# 虚拟时钟在一条命令执行期间是不动的，接上去的话 `kubectl drain` 这类
# 「重试到超时为止」的命令会永远转下去。
# 墙钟（time.Now 打出来的那个）跟虚拟时钟，输出才可复现；单调时钟走真实时间。
new_nano = old_nano
if old_wall not in source or old_nano not in source:
    raise SystemExit('wasm_exec.js 的时钟入口变了，补丁要重写')
source = source.replace(old_wall, new_wall).replace(old_nano, new_nano)
open(path, 'w').write(source)
PYEOF

ls -lh "$ROOT/$OUT_DIR/$OUT_NAME" | awk '{print "'"$OUT_NAME"':", $5}'
