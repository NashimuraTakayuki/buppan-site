# Cloudflare KV Catalog Rollout

## Default Safe State

- `USE_KV_CATALOG` is `false` in `js/config.js`.
- Deploying this branch does not switch users to Cloudflare KV until that flag is changed.
- If KV or Worker setup is incomplete, the storefront keeps using the existing GAS `getInitialData` path.

## Cloudflare Setup

1. Create a KV namespace named `buppan-public-catalog`.
2. Copy `wrangler.toml.example` to `wrangler.toml`.
3. Replace `REPLACE_WITH_BUPPAN_PUBLIC_CATALOG_NAMESPACE_ID` with the namespace ID.
4. Deploy `workers/catalog-worker.js` with Wrangler or through the Cloudflare dashboard.
5. Route `/catalog` on the production domain to the Worker.

## Apps Script Setup

1. Store these Script Properties in Apps Script:
   - `CF_ACCOUNT_ID`
   - `CF_KV_NAMESPACE_ID`
   - `CF_API_TOKEN`
2. Use a Cloudflare token with the smallest KV write scope needed for this namespace.
3. Run `setupPublicCatalogPublishTrigger()` once from the Apps Script editor.
4. Run `publishPublicCatalogToKv("initial")` once.
5. Open the Worker `/catalog` URL and confirm it returns JSON.

## Frontend Cutover

1. Keep `USE_KV_CATALOG=false` for the first deploy.
2. Verify old GAS loading still works.
3. Change `USE_KV_CATALOG=true` in a separate commit.
4. Deploy and test LINE access, school selection, product display, cart, and order confirmation.

## Rollback

- Frontend issue: set `USE_KV_CATALOG=false` and redeploy, or roll back the Cloudflare Pages/Workers deployment.
- Worker issue: roll back the Worker deployment from Cloudflare Workers > Deployments.
- GAS issue: use Apps Script deployment management and select the previous working version.
- Bad KV data: run `restorePublicCatalogFromBackup("<version>")` with the backup version key suffix.
- Emergency fallback: stop the `/catalog` Worker route or remove `publicCatalog:v1`; the frontend will fall back to GAS when KV fetch fails.

## Validation Checklist

- `/catalog` returns HTTP 200 and valid JSON.
- No secret keys appear in the JSON: channel secret, Messaging API token, admin LINE user ID, customer data, purchase history.
- Editing product, inventory, discount, or school settings marks the catalog dirty.
- The time trigger publishes dirty data within 1 to 2 minutes.
- Order submission still checks live inventory in GAS.
- Cloudflare KV reads/writes and Worker requests remain inside the free tier.
