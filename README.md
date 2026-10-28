# InfoFunnels Landing Page

Static landing page for [InfoFunnels](https://infofunnels.co) — a done-for-you webinar and VSL funnel agency for coaches and consultants.

## Files

- `index.html` — the complete page (HTML + CSS + JS, single file)
- `logo.png` — InfoFunnels logo (place in this directory)

## Setup

No build tools or dependencies required. Open `index.html` directly in a browser, or serve it with any static host.

```bash
# Quick local preview
npx serve .
# or
python3 -m http.server 8080
```

## Deploying

Drop the folder onto any static host: Netlify, Vercel, Cloudflare Pages, GitHub Pages, etc.

## Calendly

The booking section uses Calendly's official inline embed widget pointing to:
`https://calendly.com/vincent-emsmedia/meeting`

To change the Calendly URL, edit the `data-url` attribute on the `.calendly-inline-widget` div in `index.html`.

## Application forms (`/applications`)

- The builder and review screen live in HQ under **Applications** (`admin-dashboard/index.html`, owner only). `/applications` redirects there. Create a form per role (closer, setter, UGC...) and each one gets its own link, `/applications/<name>`.
- `/applications/<name>` is the public form applicants fill in (`apply/index.html`, rewritten in `vercel.json`).
- Both talk to `api/applications.js`, which stores forms and applications in the same Upstash Redis as HQ. No extra environment variables are needed.
- Applications older than 365 days are deleted when the owner opens a form's Applications tab (`RETENTION_DAYS` in `api/applications.js`). `privacy.html` says "normally no longer than 12 months", so keep the two in sync.
