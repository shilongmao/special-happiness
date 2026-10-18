# special-happiness
【DSH 插件】dsh-ssh-agent-bridge  给 dsh-ssh-ops 增加一个“远程 Agent”标签： 选择 SSH 资源和远端目录，右侧文件树直接显示服务器实时目录（WSL SSHFS 挂载）， 保存文件立即写回远端，不是本地镜像副本。命令仍走 SSH 资源的 ssh_exec。  前置： - DSH Desktop / Web - 已安装并启用 dsh-ssh-ops - Windows + WSL2 Ubuntu - SSH 资源需直连（当前验证 root 用户，AutoDL 默认 root）  安装： dsh plugin --profile desktop add dsh-ssh-agent-bridge
