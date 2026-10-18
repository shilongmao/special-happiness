# dsh-ssh-agent-bridge

一个**独立的附加插件**，为已安装的 `dsh-ssh-ops`（设置 → SSH 资源）增加：

- 右侧边栏的 **远程 Agent** 标签；
- 从 SSH 资源里选择服务器和远端目录；
- 一键打开一个正常的 DSH Agent 会话，工作区是**实时远端目录**（WSL SSHFS 挂载），不是本地镜像。

## 与 SSH 资源插件的关系

本插件**不修改、不导入、不替换** `dsh-ssh-ops`。它通过宿主服务 `ctx.get('sshOps')` 使用该插件已经注册的 Service 方法：

`profileList`、`profileConnect`、`selectConnection`、`sftpList`、`sftpReadFile`、`sftpWriteFile`、`execOnConnection`。

如果 SSH 资源插件升级后缺少这些方法，本插件会显示“不兼容”，而不是去改它的内部。SSH 资源可以继续按其发布节奏升级。

## 前置条件

- DSH Desktop / Web，且宿主提供 `sidebarRightTabs` 与 `sidebarRight`；
- 已安装并启用 [`dsh-ssh-ops`](https://www.npmjs.com/package/dsh-ssh-ops)（SSH 资源）；
- Windows + **WSL2 Ubuntu**；首次打开时插件会尝试在 WSL 中安装 `sshfs`；
- SSH 资源必须是**直连**（不支持跳板机实时挂载）；
- 服务器可写 `~/.ssh/authorized_keys`（用于安装免密挂载公钥）；
- 当前版本按 **Linux root 用户**（AutoDL 默认 root）验证；非 root 用户的 `~/.ssh` 路径尚未适配。

## 安装

### 从 npm（发布后）

```bash
dsh plugin --profile desktop add dsh-ssh-agent-bridge
```

### 从 tarball（离线分享）

```bash
dsh plugin --profile desktop add /path/to/dsh-ssh-agent-bridge-0.1.0.tgz
```

### 从 GitHub

```bash
dsh plugin --profile desktop add github:<your-name>/dsh-ssh-agent-bridge
```

安装后需要**完整退出并重新打开 DSH**（宿主插件）。

## 使用

1. 打开任意会话，展开右侧边栏；
2. 点右上角的 **+**（添加标签），选择 **远程 Agent**；
3. 选 SSH 资源，输入/浏览远端目录（例如 `/root/autodl-tmp`），点“打开实时 Agent 工作区”；
4. 首次会向服务器安装一把公钥并挂载；随后自动打开新会话。

新会话的右侧文件树就是服务器实时目录；保存文件会立即写回远端（不是定时同步）。命令仍由 SSH 资源的 `ssh_exec` 在服务器上执行，活动连接会自动切到选中的资源。

## 首次使用会做什么

1. 调用 sshOps 连接选中的 SSH 资源，并把当前活动连接切到它；
2. 在 WSL（Ubuntu）里生成专用 ed25519 密钥（私钥只留在 WSL：`/root/.ssh/dsh-ssh-agent-bridge`）；
3. 通过 sshOps 的 SFTP 把公钥追加到服务器的 `authorized_keys` / `authorized_keys2`；
4. 修正权限为 `700/.ssh`、`600/authorized_keys*`；
5. 用 WSL 的 `sshfs` 把远端目录挂到 `/mnt/dsh-ssh-agent/<slug>`；
6. 以 Windows 路径 `\\wsl.localhost\Ubuntu\mnt\dsh-ssh-agent\<slug>` 创建 DSH 工作区，再创建普通 Agent 会话。

本插件不保存 SSH 密码或私钥；连接和凭据由 `dsh-ssh-ops` 管理。

## 兼容性

- 已在 DSH Desktop + `dsh-ssh-ops 0.3.22` 环境验证；
- 依赖 `dsh-ssh-ops` 的 `sshOps` Service 方法，而这不是其正式文档化的扩展 API；升级后若方法改名，插件会明确提示不兼容；
- 本插件不会阻止或影响 `dsh-ssh-ops` 升级，最坏情况是附加功能暂不可用；
- 建议在发布说明中写明你验证过的 `dsh-ssh-ops` / DSH 版本。

## 故障排查

### 一直显示“处理中 / 连接中”

先确认服务器还在运行：

```bash
wsl -d Ubuntu -u root -- ssh -p <port> -i /root/.ssh/dsh-ssh-agent-bridge \
  -o BatchMode=yes -o ConnectTimeout=10 root@<host> hostname
```

- `Connection refused` / 连接失败：AutoDL 实例已停机或换了 host/port，更新 **设置 → SSH 资源**；
- 卡在认证：检查服务器权限 `chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys*`；
- 旧挂载残留：`wsl -d Ubuntu -u root -- fusermount3 -uz /mnt/dsh-ssh-agent/<slug>`，再刷新页面重试。

### 提示“不兼容”

`dsh-ssh-ops` 更新后缺少本插件使用的方法。先回退/升级到验证过的版本，或等本插件适配。

### 有跳板机的资源

当前实时挂载只支持直连。请先在 SSH 资源里直连，或改用 SFTP 方案。

## 卸载

```bash
dsh plugin --profile desktop remove dsh-ssh-agent-bridge
```

可选清理：

```bash
wsl -d Ubuntu -u root -- fusermount3 -uz /mnt/dsh-ssh-agent/<slug>
wsl -d Ubuntu -u root -- rm -f /root/.ssh/dsh-ssh-agent-bridge /root/.ssh/dsh-ssh-agent-bridge.pub
```

如需彻底移除服务器上的免密公钥，从 `~/.ssh/authorized_keys*` 中删除注释为 `dsh-ssh-agent-bridge` 的那一行。

## 分享

- **tarball**：`npm pack` 生成的 `dsh-ssh-agent-bridge-0.1.0.tgz` 可直接发给别人，对方用 `dsh plugin add <tgz>` 安装；
- **npm**：`npm publish --access public` 后，别人可直接 `dsh plugin add dsh-ssh-agent-bridge`；
- **GitHub**：提交源码后，别人可用 `dsh plugin add github:<user>/<repo>` 安装；建议附上 README、LICENSE、构建好的 `client.js` 和发布说明。

## 限制

- 只支持**直连** SSH 资源；有跳板机的资源会提示不支持实时挂载。
- 依赖 Windows 的 WSL + Ubuntu + `sshfs`；插件会尝试在 WSL 里自动安装 `sshfs`。
- 首次使用会向服务器的 `authorized_keys` 追加一把免密挂载公钥；这是服务器上的变化，不是对 SSH 资源插件的修改。
- `dsh-ssh-ops` 的 Service 方法不是其文档化 API；本插件做了方法存在性检查，升级后若方法改名会明确报“不兼容”。
- 目前只验证 Linux **root** 用户（AutoDL 默认）；非 root 用户需要把 `authorized_keys` 路径从 `/root` 改为该用户 home，欢迎提交 PR。

## License

MIT
