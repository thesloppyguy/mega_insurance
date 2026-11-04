# OptiModel SpatialReal packs

Local SpatialReal character packs for the OptiModel (`arkit`) provider.

| Catalog id | Character UUID                         | Directory                 |
| ---------- | -------------------------------------- | ------------------------- |
| `samira`   | `a0a234f5-0e04-483c-9cf1-3d5bd88b4442` | `avatars/samira-a0a234f5` |
| `sanjay`   | `3c409ac5-2637-4dd6-9c0c-c47c4b085966` | `avatars/sanjay-3c409ac5` |

```bash
# From apps/web/public:
cp -R ../../../avatar/public/spatialreal/avatars/samira-a0a234f5 ./spatialreal/avatars/
cp -R ../../../avatar/public/spatialreal/avatars/sanjay-3c409ac5 ./spatialreal/avatars/
# Flame template AvatarKit otherwise pulls from cdn.spatialwalk.cloud (blocked by COEP):
mkdir -p ./spatialreal/sdk
cp ../../../avatar/public/spatialreal/sdk/unified_model_body.pb.gz ./spatialreal/sdk/
```

| Public path | Source |
| ----------- | ------ |
| `/spatialreal/avatars/...` | Character packs |
| `/spatialreal/sdk/unified_model_body.pb.gz` | Spatius flame template (replaces `cdn.spatialwalk.*/public/...`) |
| `/avatar-api/v2/avatar/{id}` | AvatarKit metadata |

OptiModel is **fully offline** — it does not use `SPATIALREAL_*` / `SPATIUS_*`
env vars. `installOptiModelAssetCache()`:

- rewrites `cdn.spatialwalk.*/public/*` → `/spatialreal/sdk/*`
- stubs SpatialWalk bootstrap + telemetry so AvatarKit never calls the cloud

Do **not** use LAM `/gsplat/*.zip` packs for OptiModel.
