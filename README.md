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
