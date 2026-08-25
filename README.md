# Deadly Dozen Registration Backend

Express server that:
- Serves the registration form at `/` (`public/index.html`)
- Saves each entry (Solo / Double / Relay, all team members, pricing) to `data/registrations.json`
- Serves an admin report at `/admin/report.html` showing counts by stage (pending payment vs. paid) and by category, with a searchable/filterable table of every registration

## Local setup

```bash
npm install
ADMIN_KEY=choose-a-secret npm start
```

Then visit:
- `http://localhost:4000/` — registration form
- `http://localhost:4000/admin/report.html` — report (enter your `ADMIN_KEY` to log in)

## Deploying on Render

1. Push this repo to GitHub.
2. Create a new **Web Service** on Render pointed at the repo.
   - Build command: `npm install`
   - Start command: `npm start`
3. Add an environment variable `ADMIN_KEY` set to a secret value — this is the password for the report page. Without it, the admin endpoints are locked.

## API

- `POST /api/register` — save a completed entry (called by the form right before payment)
- `POST /api/payment-complete` — mark an entry as paid (demo payment flow, no real gateway)
- `GET /api/registrations` *(admin)* — list all registrations
- `GET /api/registrations-summary` *(admin)* — totals by status and category
- `DELETE /api/registrations/:id` *(admin)* — delete one entry
- `POST /api/registrations/bulk-delete` *(admin)* — delete several entries

All admin endpoints require an `x-admin-key` header (or `?key=` query param) matching `ADMIN_KEY`.

## Notes

- Storage is a simple JSON file (`data/registrations.json`), matching the same pattern used for the Bahubali backend. This is fine for moderate volumes; if you outgrow it, swap `readRegistrations`/`writeRegistrations` in `server.js` for a real database (e.g. Render Postgres) without touching the API routes.
- Payment is a demo flow — no Razorpay integration is wired up yet. `POST /api/payment-complete` just flips the status to `paid` when the "PAY NOW" button is clicked.
