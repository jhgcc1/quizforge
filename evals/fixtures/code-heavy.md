# Nimbus CLI

Nimbus CLI deploys static sites to the Nimbus edge network from the command line.

## Install

```bash
npm install --global nimbus-cli
nimbus login
```

The login command opens a browser window and stores a token in the operating system keychain.

## Deploy

```bash
nimbus deploy ./dist --project docs --prod
```

By default a deploy creates a preview URL. The `--prod` flag promotes the deploy to the production domain.
A deploy is rejected when the folder is larger than 500 megabytes or contains more than 20000 files.

## Flags

| Flag | Meaning | Default |
| --- | --- | --- |
| `--project` | Name of the project to deploy to | the folder name |
| `--prod` | Promote the deploy to production | off |
| `--region` | Edge region to prefer | auto |
| `--timeout` | Seconds to wait for the build | 300 |

## Rollback

```bash
nimbus rollback --to previous
```

Rollback switches the production domain back to the previous deploy in under five seconds and keeps the failed deploy for inspection.
Only the last ten deploys are kept; older ones are deleted automatically.
