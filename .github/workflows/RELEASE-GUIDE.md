# Kanban 打包和分发指南

## 自动化打包流程

本项目已配置 GitHub Actions 自动打包系统,支持两种方式生成 tgz 离线包:

### 方式 1: 通过 Git Tag 触发(推荐)

```bash
# 1. 更新 package.json 中的版本号
# 例如: "version": "0.1.69"

# 2. 创建并推送 tag
git tag v0.1.69
git push origin v0.1.69
```

GitHub Actions 会自动:
- 构建项目
- 生成 tgz 包
- 创建 GitHub Release
- 上传 tgz 文件到 Release

### 方式 2: 手动触发工作流

1. 访问 GitHub Actions 页面
2. 选择 "Build and Release Package" 工作流
3. 点击 "Run workflow"
4. 输入版本号(如: 0.1.69)
5. 点击运行

## 用户安装指南

### 从 GitHub Release 安装

1. 访问 Releases 页面: https://github.com/Capsio-Technology/kanban/releases
2. 下载最新版本的 `.tgz` 文件
3. 安装:

```bash
npm install -g kanban-0.1.69.tgz
```

### 从 npm 安装(如果已发布)

```bash
npm install -g kanban
```

### 从源码安装

```bash
git clone https://github.com/Capsio-Technology/kanban.git
cd kanban
npm install  # 或 bun install
npm run build
npm link     # 全局链接
```

## 使用 Kanban

安装完成后,直接运行:

```bash
kanban
```

## 工作流说明

### build-release.yml
- **触发条件**: 推送 v* 格式的 tag 或手动触发
- **功能**: 构建 tgz 包并发布到 GitHub Release
- **产物**: kanban-x.x.x.tgz

### publish.yml (现有)
- **触发条件**: 手动触发,需要指定 tag
- **功能**: 发布到 npm + 创建 GitHub Release
- **产物**: npm 包 + GitHub Release

### ci.yml (现有)
- **触发条件**: push/PR 到 main 分支
- **功能**: 运行测试

## 发布检查清单

发布新版本前,请确认:

- [ ] 更新 `package.json` 中的 `version` 字段
- [ ] 更新 `CHANGELOG.md` 添加新版本说明
- [ ] 所有测试通过 (`npm test`)
- [ ] 本地构建成功 (`npm run build`)
- [ ] 创建并推送 tag (`git tag vX.X.X && git push origin vX.X.X`)

## 故障排除

### 构建失败
- 检查所有必需的 Secrets 是否配置
- 确认 Bun 和 Node.js 版本兼容

### tgz 安装失败
- 确认使用 `npm install -g` 而非 `npm install`
- 检查 Node.js 版本 >= 22

### 工作流未触发
- 确认 tag 格式为 `v*` (如 v0.1.69)
- 检查 GitHub Actions 权限设置
