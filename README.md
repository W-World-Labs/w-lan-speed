# W LAN Speed

浏览器与局域网设备之间的测速工具，当前版本 1.0.2。Go 标准库服务内嵌 HTML/CSS/JavaScript，无外部字体、CDN、数据库或运行时依赖。

源码：[W-World-Labs/w-lan-speed](https://github.com/W-World-Labs/w-lan-speed)。默认只监听 loopback；使用者可显式绑定自己的 LAN IPv4。不要对公网开放。

## 构建与运行

需要 Go 1.25 或更新版本。源码不需要私有包仓库或凭据。

```sh
go vet ./...
CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o build/w-lan-speed .
./build/w-lan-speed --listen 127.0.0.1:8899
```

浏览器访问 `http://127.0.0.1:8899`。Host 和 Origin 校验要求使用绑定的完整相同地址，不提供跨域 API。

Linux 交叉编译：

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags='-s -w' -o build/w-lan-speed-linux-amd64 .
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags='-s -w' -o build/w-lan-speed-linux-arm64 .
```

## 可选部署示例

`deploy/` 不包含真实设备、内网拓扑或凭据。使用前核对目标平台、端口所有权及当前配置，保存旧二进制和单元的回滚副本；停止服务后成套替换。部署与网络调整由本机管理员显式执行，GitHub Actions 不操作已有路由器或主机。

### OpenWrt

将 ARM64 二进制安装到 `/usr/libexec/w-lan-speed`，`deploy/w-lan-speed.init` 安装到 `/etc/init.d/w-lan-speed`。从 `deploy/w-lan-speed.conf.example` 创建管理员所有的 `/etc/w-lan-speed.conf`，按自己的网络设置 `LISTEN_ADDRESS`，再启用、启动服务。示例默认只监听 `127.0.0.1:8899`。程序以 nobody 运行，日志见 `logread -e w-lan-speed`。

可选的 `PEER_URL` 是另一个私网有线对端的 HTTP 地址；浏览器直接访问对端，路由器进程不做 HTTP 反向代理。对端使用同一源码、添加 `--wired-peer`，页面会标注“有线对端”。这两种入口衡量的处理路径不同。

专用硬件 flow offload 需要显式配置 `OFFLOAD_SOURCE_CIDR`、`OFFLOAD_PEER_ADDRESS`、`OFFLOAD_PORT` 和 `OFFLOAD_DEVICES`，并自行安装 `deploy/w-lan-speed-offload` 与 `deploy/99-w-lan-speed-offload`。配置缺失时 helper 删除自己的专用表并禁用。规则只匹配指定来源范围、指定目标和单个 TCP 端口，并再次限定双方为 RFC1918 私网地址；不打开全局流量卸载，不改变现有代理和互联网流量规则。接口清单由管理员提供，不自动猜测网卡。规则更新由文件锁串行化，以单次 nft transaction 替换。

init 启动、配置重载和网络 hotplug 会重建可选规则；监听地址或对端地址修改后需重启程序。卸载前停止、禁用服务并清除自己的文件与配置；停止 init 会删除 `inet w_lan_speed` 表。通过 conntrack 的 `HW_OFFLOAD` 状态才能核实实际加速，不能只凭规则存在断言生效。公开配置模板尚未在真实路由器上验收。

### Linux 有线对端

将对应架构二进制安装到 `/usr/local/bin/w-lan-speed-peer`，`deploy/w-lan-speed-peer.service` 安装到 systemd 单元目录。从同一配置模板创建 `/etc/w-lan-speed.conf` 并设置明确的本机监听地址。单元以 nobody 运行，配置文件缺失会拒绝启动。仅为选定 LAN 来源和该端口配置本机防火墙，不关闭既有防火墙或增加公网入口；仓库不自动执行任何防火墙命令。

## 检查与发布

GitHub Actions 在 `main` 推送和 PR 中执行 Go 格式检查、`go vet`、JavaScript/Shell 语法检查，并以 `CGO_ENABLED=0` 构建 Linux amd64/arm64。打包前使用 `file` 与 `readelf` 拒绝动态链接二进制。版本标签须匹配 `openapi.json` 与程序的版本，并属于 `main` 的提交历史。

标签检查成功后，GitHub Release 提供两个静态二进制、完整源码归档、许可归属归档和 `SHA256SUMS`。下载二进制时一并保留许可归属归档，并校验 SHA-256。流程不需要业务密钥，不自动部署服务，不编写或运行单元/集成测试，也不做网络性能承诺。

## 许可证

自研代码采用 [MIT](LICENSE)。Go 标准库与运行时保留 BSD 许可。来源、适用范围及完整许可见 [NOTICE.md](NOTICE.md) 和 `licenses/`，根 MIT 许可证不覆盖这些第三方代码。

## 测量含义

- 先预热一次 HTTP 连接，再测量 12 次空载 HTTP RTT；延迟取中位数，抖动取相邻 RTT 绝对差的均值，均非 ICMP。
- 下载与上传依次执行，各约 8 秒，6 路并发。Mbps 按 1,000,000 bit/s 计算。下载计入浏览器实际读取字节，上传只计入服务端确认读取的字节；上传最后一批会读完再结束，因此可能略超过 8 秒。
- 曲线为每 250 ms 的吞吐采样，大数字与结果为当前阶段整体均值。上传曲线受每批确认时间影响。
- 测速随机数据常驻内存，不写磁盘，不压缩，不经公网。一个会话有效期 60 秒，同一时间允许一台设备、至多 6 路传输；断开后会话会自动到期。
- 停止、网络失败或切换后台会取消测速，不保存不完整结果。最近 10 次结果仅存在本机浏览器 localStorage，浏览器禁用存储时仍可测速。
- 结果受 Wi-Fi、交换链路、浏览器、系统负载及路由器 CPU 共同影响，不代表互联网带宽。测速会占用局域网带宽。

## 接口

同源 JSON/二进制 HTTP 接口，无跨项目消费者。`POST /api/session` 创建会话（冲突 409）；其余测速接口携带 `X-Speedtest-Token`，并绑定来源 IP。`GET /api/info` 返回设备名、版本、参数、`wired_peer` 与可选 `peer_url`；`GET /api/ping` 返回 204；`GET /api/download` 最多流式发送 10 秒；`POST /api/upload` 接受最多 8 MiB，返回 `{"bytes":整数}`；`DELETE /api/session` 释放会话。过期会话 403，并发超限 429，上传未完成或超限 400。详细契约见 `openapi.json`。
