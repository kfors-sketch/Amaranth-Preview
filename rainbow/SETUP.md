# Rainbow ordering on the Grand site

This package starts from the existing Grand site. Upload these files to the root of the Grand GitHub repository, keeping the folder structure. Use the full package for a first install.

| Direct link | Purpose |
| --- | --- |
| `/rainbow/store.html` | Merchandise, cart, and purchaser details |
| `/rainbow/annual-session.html` | Annual Session registration, purchaser, and attendee details |
| `/admin/rainbow/orders.html` | Merchandise orders and CSV |
| `/admin/rainbow/registrations.html` | Annual Session registrations and CSV |

The public HTML pages are accessible by direct link and omitted from Grand's menus and search indexing. The report pages use Grand's admin sign-in to protect their data and CSVs.

## Enable test checkout

1. Upload the package in one commit. `api/admin/webhook-router.js` is the only replacement of an existing Grand file. The change sends Rainbow payments to Rainbow's records instead of Grand's reports and receipts. Confirm this update is deployed at the endpoint receiving Grand's Stripe test webhooks before placing a Rainbow order. If the endpoint is the production Grand site and you are testing on a preview branch, deploy the webhook file and `api/rainbow/payment.js` together to production first.
2. Open the two public pages and review the forms. You can do this while checkout is off.
3. Set `RAINBOW_TEST_ENABLED` to `1` in the Vercel environment you are testing and redeploy. Grand's existing `STRIPE_SECRET_KEY_TEST` and writable KV environment variables must be available to that deployment. Grand's current checkout mode does not select the Rainbow payment key.
4. Use made-up details and an email such as `tester@example.com` for every purchaser and attendee. Use Stripe test card `4242 4242 4242 4242`, any future expiration, and any three-digit CVC. The cart shows the merchandise or registration subtotal. Checkout applies Grand's usual processing and applicable international fees.
5. Check the corresponding Rainbow admin page for the paid order and try its CSV. Rainbow test payments are stored separately from Grand orders. Rainbow shows a confirmation in the browser.

The sample products, prices, and lunch option are placeholders. Use `RAINBOW_TEST_ENABLED=0` and redeploy to stop new Rainbow test checkouts while keeping the pages available to review.

## Remove Rainbow

Restore Grand's original `api/admin/webhook-router.js` and delete `rainbow/`, `admin/rainbow/`, `api/rainbow/`, `assets/rainbow/`, and `tests/rainbow/` in the same commit. Remove the Rainbow Vercel setting. Existing Rainbow test records are stored under their own KV keys.
