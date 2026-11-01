# Grand Court upgrade

Ports the Supreme ordering and administration implementation at f0ab5c299b1b2c82ebf5d86b075c98f3fc130436 into the existing Grand Court site.

Includes separate reservation and shop carts, transportation, optional tours, manual reservation entry, group meals, decoration/hotel reports, scoped customer receipts, server-authoritative pricing, and protected debug/report routes. Grand welcome text, artwork, static catalog definitions, and existing add-on URL are retained. Catalogs and orders continue to use this Vercel project's existing KV connection; no database migration or data copy is performed.

## Vercel configuration before production

Keep this project's own Stripe, webhook, KV, Resend, ADMIN_PASSWORD, REPORT_TOKEN, and SITE_BASE_URL values. Do not substitute Supreme credentials or its database connection.

- CRON_SECRET: set a strong random secret for Vercel's authenticated scheduled report requests. The upgraded cron endpoints reject requests without it.
- CONTACT_TO: use the Grand contact inbox. EMAIL_CONTACT remains a fallback for this existing project.
- REPLY_TO (or REPORTS_REPLY_TO): verify the Grand reply address.
- GRAND_SECRETARY_EMAIL: optional supplies price-request recipient; EMAIL_CONTACT is the fallback.
- ADMIN_TEST_EMAIL_ALLOWLIST: optional comma-separated approved recipients for admin test emails.
- RESEND_FROM and EMAIL_RECEIPTS: verify the Grand sender and receipt backup inbox.

Existing settings:overrides and catalog entries in Grand KV are retained. Review payment mode, live windows, event dates, chair emails, and lockdown settings before accepting orders. Public purchasable lists now require server catalogs; static files are not a public purchase fallback. Tours appear only when active tours are configured.

## Validation

77 inherited automated tests pass. JavaScript files and classic inline scripts pass syntax checks (196 checks). Live Stripe checkout, Resend delivery, scheduled reports, browser interactions, and existing KV data compatibility require a Vercel preview with the Grand configuration. Local verification used Node 24; Vercel remains configured for Node 22.
