// Add-on for dsh-ssh-ops ("SSH 资源").
//
// This plugin does not import, wrap, or modify dsh-ssh-ops. It consumes the
// host service that plugin publishes as `sshOps` and uses only its public
// methods: profileList, profileConnect, selectConnection, sftpList,
// sftpReadFile, sftpWriteFile, execOnConnection. If that service is absent or lacks a method,
// the add-on reports that instead of reaching into internals.
//
// The add-on turns a saved SSH resource plus a remote folder into a live
// workspace: WSL's sshfs mounts the folder, and the normal DSH file tree/editor
// uses that mount directly. Commands stay on the GPU host through the SSH
// 资源 plugin's own ssh_exec tool.

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'

export const name = 'ssh-agent-bridge'
export const inject = ['connection', 'workspaceRegistry', 'sessionController']

const WSL_DISTRO = 'Ubuntu'
const WSL_MOUNT_ROOT = '/mnt/dsh-ssh-agent'
const WSL_KEY = '/root/.ssh/dsh-ssh-agent-bridge'

class BridgeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

function fail(code, message) {
  throw new BridgeError(code, message)
}

function shq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function runWsl(command, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('wsl.exe', ['-d', WSL_DISTRO, '-u', 'root', '--', 'bash', '-lc', command], {
        windowsHide: true,
      })
    } catch (error) {
      reject(new BridgeError('wsl-missing', `无法运行 WSL：${error?.message ?? String(error)}`))
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        // ignore
      }
      reject(new BridgeError('wsl-timeout', `WSL 命令超时（${Math.round(timeoutMs / 1000)} 秒）`))
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new BridgeError('wsl-missing', `无法运行 WSL：${error?.message ?? String(error)}`))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

function requireSshOps(ctx) {
  const service = ctx.get?.('sshOps')
  if (service === undefined) {
    fail('ssh-ops-missing', '未找到 dsh-ssh-ops 的 sshOps 服务。请先安装并启用“SSH 资源”插件，再打开这个附加插件。')
  }
  for (const method of ['profileList', 'profileConnect', 'selectConnection', 'sftpList', 'sftpReadFile', 'sftpWriteFile', 'execOnConnection']) {
    if (typeof service[method] !== 'function') {
      fail('ssh-ops-incompatible', `当前“SSH 资源”版本缺少 ${method}，附加插件暂不兼容。升级或回退 SSH 资源插件后重试。`)
    }
  }
  return service
}

function unwrap(result, label) {
  if (result === undefined || result === null) fail('ssh-ops-empty', `${label}：SSH 资源没有返回结果`)
  if (result.ok !== true) {
    const message = result.error?.message ?? result.error?.code ?? String(result)
    throw new BridgeError(result.error?.code ?? 'ssh-ops-failed', `${label}：${message}`)
  }
  return result.value
}

async function listResources(ctx) {
  const service = requireSshOps(ctx)
  const profiles = unwrap(await service.profileList(), '读取 SSH 资源失败').profiles ?? []
  return profiles.map((profile) => ({
    profileId: profile.profileId,
    name: profile.name,
    host: profile.host,
    port: profile.port,
    username: profile.username,
    authKind: profile.authKind,
    defaultProjectPath: profile.defaultProjectPath ?? null,
    connected: profile.connected === true,
    proxyJumpCount: Array.isArray(profile.proxyJump) ? profile.proxyJump.length : 0,
    credentialConfigured: profile.credentialConfigured === true,
  }))
}

async function ensureConnection(ctx, profileId) {
  const service = requireSshOps(ctx)
  const value = unwrap(
    await service.profileConnect({ profileId, reuseExisting: true }),
    '连接 SSH 资源失败',
  )
  if (typeof value?.connectionId !== 'string' || value.connectionId === '') {
    fail('ssh-ops-incompatible', 'SSH 资源连接没有返回 connectionId，附加插件暂不兼容。')
  }
  try {
    await service.selectConnection({ connectionId: value.connectionId })
  } catch {
    // The mount does not require the active connection, but ssh_exec does.
  }
  return value
}

async function browse(ctx, profileId, requestedPath) {
  const service = requireSshOps(ctx)
  const profiles = unwrap(await service.profileList(), '读取 SSH 资源失败').profiles ?? []
  const profile = profiles.find((item) => item.profileId === profileId)
  if (profile === undefined) fail('no-profile', 'SSH 资源不存在或已被删除。')
  const connection = await ensureConnection(ctx, profileId)
  const path = typeof requestedPath === 'string' && requestedPath !== ''
    ? requestedPath
    : (profile.defaultProjectPath || '/root')
  const value = unwrap(await service.sftpList({ connectionId: connection.connectionId, path }), '读取远端目录失败')
  return {
    path: value.path,
    entries: (value.entries ?? []).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory ? 'dir' : 'file',
      size: entry.size,
      mtime: entry.mtime,
    })),
  }
}

async function ensureWslReady() {
  const check = await runWsl(
    'command -v sshfs >/dev/null 2>&1 && command -v ssh-keygen >/dev/null 2>&1 && command -v fusermount3 >/dev/null 2>&1 && echo READY',
    20000,
  )
  if (check.code === 0 && check.stdout.includes('READY')) return
  const install = await runWsl(
    'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq sshfs openssh-client',
    240000,
  )
  if (install.code !== 0) {
    fail('wsl-sshfs-missing', `WSL 中安装 sshfs 失败：${(install.stderr || install.stdout).slice(-500)}`)
  }
  const again = await runWsl('command -v sshfs >/dev/null 2>&1 && echo READY', 10000)
  if (again.code !== 0 || !again.stdout.includes('READY')) {
    fail('wsl-sshfs-missing', 'WSL 中没有 sshfs，无法挂载远端目录。')
  }
}

async function ensureWslKey() {
  const result = await runWsl(
    `mkdir -p /root/.ssh; chmod 700 /root/.ssh; if [ ! -f ${shq(WSL_KEY)} ]; then ssh-keygen -t ed25519 -f ${shq(WSL_KEY)} -N '' -C dsh-ssh-agent-bridge -q; fi; cat ${shq(WSL_KEY)}.pub`,
    30000,
  )
  const publicKey = result.stdout.trim()
  if (result.code !== 0 || !/^ssh-(ed25519|rsa|ecdsa)\s+/.test(publicKey)) {
    fail('wsl-key-failed', `WSL 公钥生成失败：${(result.stderr || result.stdout).slice(-500)}`)
  }
  return publicKey
}

async function installPublicKey(ctx, connectionId, publicKey) {
  const service = requireSshOps(ctx)
  const files = ['/root/.ssh/authorized_keys', '/root/.ssh/authorized_keys2']
  let installed = false
  for (const file of files) {
    const read = await service.sftpReadFile({ connectionId, path: file, maxBytes: 256 * 1024 })
    if (read?.ok !== true) continue
    const text = Buffer.from(read.value.data, 'base64').toString('utf8')
    const lines = text.split(/\r?\n/).map((line) => line.trim())
    if (lines.includes(publicKey)) {
      installed = true
      continue
    }
    const next = text === '' ? `${publicKey}\n` : text.endsWith('\n') ? `${text}${publicKey}\n` : `${text}\n${publicKey}\n`
    const write = await service.sftpWriteFile({
      connectionId,
      path: file,
      data: Buffer.from(next, 'utf8').toString('base64'),
    })
    if (write?.ok === true) installed = true
  }
  if (!installed) {
    fail(
      'key-install-failed',
      '服务器上没有可写的 ~/.ssh/authorized_keys（或 authorized_keys2），无法安装免密挂载公钥。请先在 SSH 资源面板用密码登录一次，或手动把 WSL 公钥加入服务器。',
    )
  }
  // SFTP createWriteStream may leave a world-writable file; sshd StrictModes
  // then rejects the key and sshfs waits at authentication forever. Fix the
  // modes before any mount attempt.
  const chmod = await service.execOnConnection(
    connectionId,
    'chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys ~/.ssh/authorized_keys2',
    30000,
  )
  if (chmod?.ok !== true) {
    fail(
      'key-permission-failed',
      `公钥已写入，但无法修正 authorized_keys 权限（需要 700/600）：${chmod?.error?.message ?? 'SSH 资源执行器拒绝了 chmod'}。`,
    )
  }
}

function mountSlug(profile, remotePath) {
  const readable = (profile.name || profile.host || 'remote')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28) || 'remote'
  const digest = createHash('sha256')
    .update(`${profile.profileId}\u0000${profile.host}\u0000${profile.port}\u0000${remotePath}`)
    .digest('hex')
    .slice(0, 10)
  return `${readable}-${digest}`
}

async function ensureMount(ctx, profile, remotePath) {
  await ensureWslReady()
  const publicKey = await ensureWslKey()
  const connection = await ensureConnection(ctx, profile.profileId)
  await installPublicKey(ctx, connection.connectionId, publicKey)

  const slug = mountSlug(profile, remotePath)
  const mountPoint = `${WSL_MOUNT_ROOT}/${slug}`
  const health = await runWsl(
    `if mountpoint -q ${shq(mountPoint)}; then timeout 8 ls -d ${shq(mountPoint)} >/dev/null 2>&1 && echo HEALTHY || echo UNHEALTHY; else echo MISSING; fi`,
    15000,
  )
  if (!health.stdout.includes('HEALTHY')) {
    // A previous sshfs can stay registered while its SSH channel is dead; a
    // plain existsSync/stat on that mount hangs forever. Lazy-unmount it first.
    await runWsl(`fusermount3 -uz ${shq(mountPoint)} 2>/dev/null || true`, 15000).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 700))

    const destination = `${profile.username ? `${profile.username}@` : ''}${profile.host}:${remotePath}`
    const command = [
      `mkdir -p ${shq(WSL_MOUNT_ROOT)}`,
      `mkdir -p ${shq(mountPoint)}`,
      `fusermount3 -uz ${shq(mountPoint)} 2>/dev/null || true`,
      `sshfs -p ${Number(profile.port) || 22} -o IdentityFile=${shq(WSL_KEY)} -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/.ssh/dsh-ssh-agent-known_hosts -o reconnect -o ServerAliveInterval=15 -o ServerAliveCountMax=3 ${shq(destination)} ${shq(mountPoint)}`,
      `if mountpoint -q ${shq(mountPoint)}; then timeout 8 ls -d ${shq(mountPoint)} >/dev/null 2>&1 && echo MOUNT_OK || { echo MOUNT_UNHEALTHY; exit 1; }; else echo MOUNT_FAILED; exit 1; fi`,
    ].join('; ')
    const result = await runWsl(command, 60000)
    if (result.code !== 0 || !result.stdout.includes('MOUNT_OK')) {
      fail('mount-failed', `WSL SSHFS 挂载失败：${(result.stderr || result.stdout).slice(-700)}`)
    }
  }

  const windowsPath = `\\\\wsl.localhost\\${WSL_DISTRO}\\mnt\\dsh-ssh-agent\\${slug}`
  for (let index = 0; index < 30; index += 1) {
    if (existsSync(windowsPath)) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!existsSync(windowsPath)) {
    fail('mount-not-visible', `挂载已建立，但 Windows 路径还不可见：${windowsPath}`)
  }
  return { windowsPath, mountPoint, connectionId: connection.connectionId }
}

async function openAgent(ctx, profileId, remotePath) {
  const service = requireSshOps(ctx)
  const profiles = unwrap(await service.profileList(), '读取 SSH 资源失败').profiles ?? []
  const profile = profiles.find((item) => item.profileId === profileId)
  if (profile === undefined) fail('no-profile', 'SSH 资源不存在或已被删除。')
  if (Array.isArray(profile.proxyJump) && profile.proxyJump.length > 0) {
    fail('jump-unsupported', '这个 SSH 资源包含跳板机；当前实时挂载只支持直连服务器。可以先在“SSH 资源”里直连，或改用 SFTP 镜像方案。')
  }
  if (typeof remotePath !== 'string' || !remotePath.startsWith('/')) {
    fail('invalid-path', '远端目录必须是绝对路径，例如 /root/autodl-tmp。')
  }

  const mount = await ensureMount(ctx, profile, remotePath)
  const title = `远程: ${profile.name} — ${remotePath}`
  const workspace = await ctx.workspaceRegistry.create(mount.windowsPath, title)
  const created = await ctx.sessionController.create({ workspaceId: workspace.id })
  const sessionId = created.sessionId
  try {
    await ctx.sessionController.rename({ sessionId, title })
  } catch {
    // cosmetic
  }
  let promptError
  try {
    const setup = [
      '（实时远端工作区已建立）',
      `服务器：${profile.name}（${profile.username ? `${profile.username}@` : ''}${profile.host}:${profile.port}）`,
      `远端目录：${remotePath}`,
      `本地挂载：${mount.windowsPath}`,
      '',
      '请先只回复“远程工作区已就绪”。之后按以下规则工作：',
      '1. 右侧文件树就是服务器实时目录；直接用本地 read/edit/write 修改文件，保存会立即写到服务器。',
      '2. 所有项目命令用 ssh_exec 执行（当前活动 SSH 连接已切到这个资源）；不要用本地 bash/pwsh 运行 GPU 项目。',
      '3. 训练、下载等长任务用 screen/tmux/nohup 守护，单次工具调用保持短小。',
      '4. 需要查看实时日志时用 ssh_exec tail；镜像跳过的文件不存在，因为这里是实时挂载。',
    ].join('\n')
    await ctx.sessionController.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: setup }],
    }, AbortSignal.timeout(30_000))
  } catch (error) {
    promptError = error?.message ?? String(error)
  }
  return {
    sessionId,
    workspaceId: workspace.id,
    localPath: mount.windowsPath,
    remotePath,
    server: profile.name,
    mode: 'mount',
    ...(promptError === undefined ? {} : { promptError }),
  }
}

async function dispatch(ctx, action, payload) {
  if (action === 'resources') {
    return { profiles: await listResources(ctx) }
  }
  if (action === 'browse') {
    const profileId = typeof payload?.profileId === 'string' ? payload.profileId : ''
    if (profileId === '') fail('invalid-input', '请选择一个 SSH 资源。')
    return await browse(ctx, profileId, payload?.path)
  }
  if (action === 'open') {
    const profileId = typeof payload?.profileId === 'string' ? payload.profileId : ''
    const remotePath = typeof payload?.path === 'string' ? payload.path.trim() : ''
    if (profileId === '') fail('invalid-input', '请选择一个 SSH 资源。')
    if (remotePath === '') fail('invalid-input', '请选择远端目录。')
    return await openAgent(ctx, profileId, remotePath)
  }
  fail('unknown-action', `未知操作：${String(action)}`)
}

export function apply(ctx) {
  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: '/api/ssh-agent-bridge',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body
        try {
          body = await request.json()
        } catch {
          body = {}
        }
        try {
          const value = await dispatch(ctx, body?.action, body?.payload ?? {})
          return new Response(JSON.stringify({ ok: true, value }), {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          })
        } catch (error) {
          return new Response(JSON.stringify({
            ok: false,
            error: {
              code: error?.code ?? 'failed',
              message: error?.message ?? String(error),
            },
          }), {
            status: 200,
            headers: { 'content-type': 'application/json; charset=utf-8' },
          })
        }
      },
    })
    return () => {
      dispose()
    }
  }, 'ssh-agent-bridge: api route')
}
