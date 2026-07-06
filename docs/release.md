# 发布流程

本仓库遵循标准 brick 发布流程：

```text
校验 brick definition
运行 smoke 测试
构建 runtime artifact
生成 descriptor.local.json
上传 artifact 到 OSS
生成 descriptor.oss.json
执行 verify
发布 npm SDK
```

## 本地发布检查

```bash
npm run release:local
```

## GitHub Actions

输入参数：

```text
artifact_mode = skip | placeholder | oss
publish_npm = false | true
```

安装 GitHub Packages 依赖需要：

```text
PACKAGES_READ_TOKEN
```

`artifact_mode=oss` 需要：

```text
OSS_BUCKET
OSS_ENDPOINT
OSS_REGION
OSS_ACCESS_KEY_ID
OSS_ACCESS_KEY_SECRET
OSS_PUBLIC_BASE_URL
```

默认 OSS namespace：

```text
bricks/tool/agent-tool/<version>/
```
