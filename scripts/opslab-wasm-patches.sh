#!/usr/bin/env bash
#
# 给 vendor 树打 js/wasm 补丁。
#
# 每一处都是同一个成因：上游用 `//go:build !windows` 表示「类 Unix」，
# 而 js/wasm 也满足 !windows，于是终端 ioctl、进程信号这些浏览器里不存在的
# 东西被编了进来。补丁把这些文件排除在 js 之外，再补一份 js 版空实现。
set -euo pipefail
V="${1:-vendor}"

sed_i() { if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi; }

# --- 1. moby/term：终端 ioctl ---------------------------------------------
for f in term_unix.go termios_unix.go; do
  sed_i 's|^//go:build !windows$|//go:build !windows \&\& !js|; s|^// +build !windows$|// +build !windows,!js|' "$V/github.com/moby/term/$f"
done
sed_i 's|^//go:build !darwin && !freebsd && !netbsd && !openbsd && !windows$|//go:build !darwin \&\& !freebsd \&\& !netbsd \&\& !openbsd \&\& !windows \&\& !js|' \
  "$V/github.com/moby/term/termios_nonbsd.go"

cat > "$V/github.com/moby/term/term_js.go" <<'EOF'
//go:build js

package term

import (
	"errors"
	"io"
	"os"
)

// 浏览器里没有 tty：查询一律回答「不是终端」，设置类操作一律空操作。
// 真正的交互式终端由 xterm.js 提供，不经过这一层。

var ErrInvalidState = errors.New("Invalid terminal state")

type terminalState struct{}

type Termios struct{}

func stdStreams() (stdIn io.ReadCloser, stdOut, stdErr io.Writer) {
	return os.Stdin, os.Stdout, os.Stderr
}

func getFdInfo(in interface{}) (uintptr, bool) {
	if file, ok := in.(*os.File); ok {
		return file.Fd(), false
	}
	return 0, false
}

func getWinsize(fd uintptr) (*Winsize, error)         { return &Winsize{Height: 24, Width: 80}, nil }
func setWinsize(fd uintptr, ws *Winsize) error        { return nil }
func isTerminal(fd uintptr) bool                      { return false }
func restoreTerminal(fd uintptr, state *State) error  { return nil }
func saveState(fd uintptr) (*State, error)            { return &State{}, nil }
func disableEcho(fd uintptr, state *State) error      { return nil }
func setRawTerminal(fd uintptr) (*State, error)       { return &State{}, nil }
func setRawTerminalOutput(fd uintptr) (*State, error) { return &State{}, nil }
func makeRaw(fd uintptr) (*State, error)              { return &State{}, nil }
EOF

# --- 2. kubectl interrupt：js 没有 SIGHUP/SIGQUIT --------------------------
python3 - "$V" <<'PY'
import io, sys
v = sys.argv[1]
p = f'{v}/k8s.io/kubectl/pkg/util/interrupt/interrupt.go'
s = io.open(p, encoding='utf-8').read()
s = s.replace('\t"syscall"\n', '')
s = s.replace(
    'var terminationSignals = []os.Signal{syscall.SIGHUP, syscall.SIGINT, syscall.SIGTERM, syscall.SIGQUIT}',
    'var terminationSignals = platformTerminationSignals()')
io.open(p, 'w', encoding='utf-8').write(s)

p = f'{v}/k8s.io/kubectl/pkg/cmd/plugin.go'
s = io.open(p, encoding='utf-8').read()
s = s.replace(
    'return syscall.Exec(executablePath, append([]string{executablePath}, cmdArgs...), environment)',
    'return platformExec(executablePath, append([]string{executablePath}, cmdArgs...), environment)')
s = s.replace('\t"syscall"\n', '')
io.open(p, 'w', encoding='utf-8').write(s)

p = f'{v}/k8s.io/client-go/transport/transport.go'
s = io.open(p, encoding='utf-8').read()
s = s.replace('\t\trt, err = tlsCache.get(config)', '\t\trt, err = baseRoundTripper(config)')
io.open(p, 'w', encoding='utf-8').write(s)
PY

cat > "$V/k8s.io/kubectl/pkg/util/interrupt/signals_other.go" <<'EOF'
//go:build !js

package interrupt

import (
	"os"
	"syscall"
)

func platformTerminationSignals() []os.Signal {
	return []os.Signal{syscall.SIGHUP, syscall.SIGINT, syscall.SIGTERM, syscall.SIGQUIT}
}
EOF
cat > "$V/k8s.io/kubectl/pkg/util/interrupt/signals_js.go" <<'EOF'
//go:build js

package interrupt

import "os"

// 浏览器里没有进程信号，只留 os.Interrupt 这个 Go 运行时认得的占位。
func platformTerminationSignals() []os.Signal { return []os.Signal{os.Interrupt} }
EOF

# --- 3. umask / SIGWINCH / plugin exec ------------------------------------
sed_i 's|^//go:build !windows$|//go:build !windows \&\& !js|' \
  "$V/k8s.io/kubectl/pkg/util/umask.go" "$V/k8s.io/kubectl/pkg/util/term/resizeevents.go"

cat > "$V/k8s.io/kubectl/pkg/util/umask_js.go" <<'EOF'
//go:build js

package util

// Umask 在浏览器里没有意义。
func Umask(mask int) (old int, err error) { return 0, nil }
EOF
cat > "$V/k8s.io/kubectl/pkg/util/term/resizeevents_js.go" <<'EOF'
//go:build js

package term

// 浏览器里没有 SIGWINCH：尺寸变化由 xterm.js 的 resize 事件驱动。
// 关掉 channel 等价于「窗口从不改变大小」，调用方本来就要处理 channel 关闭。
func monitorResizeEvents(fd uintptr, resizeEvents chan<- TerminalSize, stop chan struct{}) {
	close(resizeEvents)
}
EOF
cat > "$V/k8s.io/kubectl/pkg/cmd/plugin_exec_other.go" <<'EOF'
//go:build !js

package cmd

import "syscall"

func platformExec(path string, argv []string, envv []string) error {
	return syscall.Exec(path, argv, envv)
}
EOF
cat > "$V/k8s.io/kubectl/pkg/cmd/plugin_exec_js.go" <<'EOF'
//go:build js

package cmd

import "fmt"

// 浏览器里没有进程可以 exec —— opslab 不支持 kubectl 插件。
// 明确报错，好过装作执行了什么。
func platformExec(path string, argv []string, envv []string) error {
	return fmt.Errorf("kubectl plugins are not supported in this environment: cannot exec %s", path)
}
EOF

# --- 4. client-go：浏览器里没有 socket，统一走 fetch -----------------------
cat > "$V/k8s.io/client-go/transport/base_other.go" <<'EOF'
//go:build !js

package transport

import "net/http"

func baseRoundTripper(config *Config) (http.RoundTripper, error) {
	return tlsCache.get(config)
}
EOF

cat > "$V/k8s.io/client-go/transport/base_js.go" <<'EOF'
//go:build js

package transport

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"strings"
	"syscall/js"
)

// 浏览器里没有 socket 也没有可用的 TLS 栈：所有请求交给宿主的 fetch。
// opslab 把 fetch 指向内存里的 apiserver，于是真 kubectl 打的就是我们的集群。
type jsFetchRoundTripper struct{}

func baseRoundTripper(config *Config) (http.RoundTripper, error) {
	return jsFetchRoundTripper{}, nil
}

func (jsFetchRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	var bodyBytes []byte
	if req.Body != nil {
		b, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		bodyBytes = b
		req.Body.Close()
	}

	headers := js.Global().Get("Object").New()
	for k, vs := range req.Header {
		headers.Set(k, strings.Join(vs, ", "))
	}

	init := js.Global().Get("Object").New()
	init.Set("method", req.Method)
	init.Set("headers", headers)
	if len(bodyBytes) > 0 {
		buf := js.Global().Get("Uint8Array").New(len(bodyBytes))
		js.CopyBytesToJS(buf, bodyBytes)
		init.Set("body", buf)
	}

	type result struct {
		status int
		header http.Header
		body   []byte
		err    error
	}
	ch := make(chan result, 1)

	var onOK, onErr, onBuf js.Func
	var resp js.Value

	onBuf = js.FuncOf(func(_ js.Value, args []js.Value) any {
		defer onBuf.Release()
		arr := js.Global().Get("Uint8Array").New(args[0])
		out := make([]byte, arr.Get("length").Int())
		js.CopyBytesToGo(out, arr)
		h := http.Header{}
		if hdrs := resp.Get("headers"); !hdrs.IsUndefined() {
			hdrs.Call("forEach", js.FuncOf(func(_ js.Value, a []js.Value) any {
				h.Add(a[1].String(), a[0].String())
				return nil
			}))
		}
		if h.Get("Content-Type") == "" {
			h.Set("Content-Type", "application/json")
		}
		ch <- result{status: resp.Get("status").Int(), header: h, body: out}
		return nil
	})
	onOK = js.FuncOf(func(_ js.Value, args []js.Value) any {
		defer onOK.Release()
		resp = args[0]
		resp.Call("arrayBuffer").Call("then", onBuf)
		return nil
	})
	onErr = js.FuncOf(func(_ js.Value, args []js.Value) any {
		defer onErr.Release()
		ch <- result{err: fmt.Errorf("fetch failed: %s", args[0].Call("toString").String())}
		return nil
	})

	js.Global().Call("fetch", req.URL.String(), init).Call("then", onOK).Call("catch", onErr)

	r := <-ch
	if r.err != nil {
		return nil, r.err
	}
	return &http.Response{
		Status:        fmt.Sprintf("%d", r.status),
		StatusCode:    r.status,
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		Header:        r.header,
		Body:          io.NopCloser(bytes.NewReader(r.body)),
		ContentLength: int64(len(r.body)),
		Request:       req,
	}, nil
}
EOF

# --- 5. client-go：只说 JSON，不要 protobuf --------------------------------
#
# `kubectl create configmap` 这类走 typed client 的命令会把请求体编成
# Kubernetes 自己的 protobuf（`k8s\0` 开头的那个封装）。我们的 apiserver 只讲
# JSON，于是这些命令一律报「the request body is not valid JSON」——
# 而 `kubectl apply` 因为走 unstructured 客户端反倒是好的，这种「一半命令能用」
# 最难查。
#
# 协商的入口只有一个函数，改成不做事即可。学员那边完全看不出区别：
# 命令、输出、报错都一样，变的只是线上的编码。
python3 - "$V" <<'PYEOF'
import re, sys
path = f"{sys.argv[1]}/k8s.io/client-go/rest/request.go"
source = open(path).read()
old = """func (r *Request) UseProtobufAsDefault() *Request {
	if r.contentTypeNotSet && len(r.contentConfig.AcceptContentTypes) == 0 {
		r.contentConfig.AcceptContentTypes = "application/vnd.kubernetes.protobuf,application/json"
		r.contentConfig.ContentType = "application/vnd.kubernetes.protobuf"
		r.setAcceptHeader()
	}
	return r
}"""
new = """func (r *Request) UseProtobufAsDefault() *Request {
	// opslab: 宿主的 apiserver 只讲 JSON，这里不切 protobuf。
	return r
}"""
if old not in source:
    raise SystemExit("UseProtobufAsDefault 的样子变了，补丁要重写")
open(path, "w").write(source.replace(old, new))
PYEOF

# --- 6. websocket：让 gorilla 通过宿主提供的通道拨号 ----------------------
#
# `kubectl exec` / `logs -f` / `port-forward` 走的是 WebSocket（v5.channel.k8s.io）。
# 上层全是真的 client-go remotecommand，问题只在最底下一层：gorilla 要一个
# net.Conn，而 js/wasm 里没有 socket。
#
# 好在 gorilla 的 Dialer 有 NetDialContext 钩子。补一个由宿主 JS 提供的
# net.Conn 进去，握手、分帧、子协议协商就全都还是真的走一遍。
cat > "$V/k8s.io/client-go/transport/websocket/opslab_dial_js.go" <<'EOF'
//go:build js

package websocket

import (
	"context"
	"errors"
	"io"
	"net"
	"syscall/js"
	"time"
)

// opslabConn 是一条由宿主 JS 提供的双向字节通道。
//
// 宿主那边是一个内存里的 WebSocket 服务端，所以 gorilla 照常做握手与分帧，
// 只是字节没有真的过网卡。
type opslabConn struct {
	handle  js.Value
	incoming chan []byte
	pending []byte
	closed  chan struct{}
	onData  js.Func
	onClose js.Func
}

func opslabDial(ctx context.Context, network, address string) (net.Conn, error) {
	dial := js.Global().Get("__opslabDial")
	if !dial.Truthy() {
		return nil, errors.New("opslab: 宿主没有提供 __opslabDial")
	}
	handle := dial.Invoke(address)
	if !handle.Truthy() {
		return nil, errors.New("opslab: 连不上 " + address)
	}

	conn := &opslabConn{
		handle:   handle,
		incoming: make(chan []byte, 64),
		closed:   make(chan struct{}),
	}
	conn.onData = js.FuncOf(func(this js.Value, args []js.Value) any {
		if len(args) == 0 {
			return nil
		}
		buffer := make([]byte, args[0].Get("length").Int())
		js.CopyBytesToGo(buffer, args[0])
		select {
		case conn.incoming <- buffer:
		case <-conn.closed:
		}
		return nil
	})
	conn.onClose = js.FuncOf(func(this js.Value, args []js.Value) any {
		conn.shutdown()
		return nil
	})
	handle.Set("onData", conn.onData)
	handle.Set("onClose", conn.onClose)
	return conn, nil
}

func (c *opslabConn) Read(p []byte) (int, error) {
	if len(c.pending) == 0 {
		select {
		case chunk, ok := <-c.incoming:
			if !ok {
				return 0, io.EOF
			}
			c.pending = chunk
		case <-c.closed:
			return 0, io.EOF
		}
	}
	n := copy(p, c.pending)
	c.pending = c.pending[n:]
	return n, nil
}

func (c *opslabConn) Write(p []byte) (int, error) {
	select {
	case <-c.closed:
		return 0, io.ErrClosedPipe
	default:
	}
	buffer := js.Global().Get("Uint8Array").New(len(p))
	js.CopyBytesToJS(buffer, p)
	c.handle.Call("send", buffer)
	return len(p), nil
}

func (c *opslabConn) Close() error {
	if c.handle.Truthy() {
		c.handle.Call("close")
	}
	c.shutdown()
	return nil
}

func (c *opslabConn) shutdown() {
	select {
	case <-c.closed:
		return
	default:
	}
	close(c.closed)
	c.onData.Release()
	c.onClose.Release()
}

type opslabAddr struct{}

func (opslabAddr) Network() string { return "opslab" }
func (opslabAddr) String() string  { return "opslab" }

func (c *opslabConn) LocalAddr() net.Addr                { return opslabAddr{} }
func (c *opslabConn) RemoteAddr() net.Addr               { return opslabAddr{} }
func (c *opslabConn) SetDeadline(t time.Time) error      { return nil }
func (c *opslabConn) SetReadDeadline(t time.Time) error  { return nil }
func (c *opslabConn) SetWriteDeadline(t time.Time) error { return nil }
EOF

# 把钩子挂到 Dialer 上
python3 - "$V" <<'PYEOF'
import sys
path = f"{sys.argv[1]}/k8s.io/client-go/transport/websocket/roundtripper.go"
source = open(path).read()
old = """	dialer := gwebsocket.Dialer{
		Proxy:           rt.Proxier,"""
new = """	dialer := gwebsocket.Dialer{
		// opslab: js/wasm 里没有 socket，走宿主提供的内存通道。
		// 握手、分帧、子协议协商仍然是 gorilla 真的做一遍。
		NetDialContext:  opslabDialContext,
		Proxy:           rt.Proxier,"""
if old not in source:
    raise SystemExit("websocket RoundTrip 的样子变了，补丁要重写")
source = source.replace(old, new)

# 通道本身就是宿主提供的内存管道，没有网卡也没有 TLS 记录层。
# 不改这里的话 gorilla 会对着 https 的 kubeconfig 选 wss，然后在我们的
# 管道上发一个 ClientHello 等 ServerHello —— 永远等不到，整条 exec 卡死。
# fetch 那条路同样没有真 TLS，两边保持一致。
old_scheme = (
    '\tswitch request.URL.Scheme {\n'
    '\tcase "https":\n'
    '\t\trequest.URL.Scheme = "wss"\n'
    '\tcase "http":\n'
    '\t\trequest.URL.Scheme = "ws"\n'
)
new_scheme = (
    '\tswitch request.URL.Scheme {\n'
    '\tcase "https", "http":\n'
    '\t\t// opslab: 通道是宿主给的内存管道，没有 TLS 记录层，统一走 ws\n'
    '\t\trequest.URL.Scheme = "ws"\n'
)
if old_scheme not in source:
    raise SystemExit("websocket 的 scheme 切换变了，补丁要重写")
open(path, "w").write(source.replace(old_scheme, new_scheme))
PYEOF

# 非 js 平台上钩子是空的，保持可编译
cat > "$V/k8s.io/client-go/transport/websocket/opslab_dial_other.go" <<'EOF'
//go:build !js

package websocket

import (
	"context"
	"net"
)

var opslabDialContext func(ctx context.Context, network, address string) (net.Conn, error)
EOF

cat > "$V/k8s.io/client-go/transport/websocket/opslab_dial_hook_js.go" <<'EOF'
//go:build js

package websocket

import (
	"context"
	"net"
)

var opslabDialContext func(ctx context.Context, network, address string) (net.Conn, error) = opslabDial
EOF

echo "js/wasm 补丁已应用"
