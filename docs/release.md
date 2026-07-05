# Release

This repository follows the standard brick workflow:

```text
validate brick definition
run smoke tests
build runtime artifact
create descriptor.local.json
publish artifact to OSS
create descriptor.oss.json
verify
publish npm SDK
```

## Local

```bash
npm run release:local
```

## GitHub Actions

Inputs:

```text
artifact_mode = skip | placeholder | oss
publish_npm = false | true
```

Required secret for dependency install:

```text
PACKAGES_READ_TOKEN
```

Required secrets for `artifact_mode=oss`:

```text
OSS_BUCKET
OSS_ENDPOINT
OSS_REGION
OSS_ACCESS_KEY_ID
OSS_ACCESS_KEY_SECRET
OSS_PUBLIC_BASE_URL
```

The OSS namespace defaults to:

```text
bricks/tool/agent-tool/<version>/
```

