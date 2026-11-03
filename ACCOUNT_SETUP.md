# WRENDERFLOW account database setup

Create a Cloudflare D1 database named `wrenderflow-db`, then apply this migration:

```bash
npx wrangler d1 create wrenderflow-db
npx wrangler d1 execute wrenderflow-db --remote --file=./migrations/0001_accounts.sql
```

In the Cloudflare Worker settings, add a D1 database binding:
- Variable name: `DB`
- Database: `wrenderflow-db`

Keep the existing Workers AI binding named `AI` and static assets binding named `ASSETS`.

The account API uses PBKDF2-SHA-256 password hashing (210,000 iterations), SHA-256 hashed opaque session tokens, HttpOnly/Secure/SameSite=Lax cookies, and 30-day sessions. Do not expose the D1 binding or password data to the browser.

Until the `DB` binding is connected, guest rendering continues to work and account endpoints return a clear configuration message.
