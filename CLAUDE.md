# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Static HTML website for **ARC FUKAMEKI minoh / フカメキ雑貨店** — a Japanese miscellaneous goods shop in Minoh, Osaka. No build tools, no package manager, no framework. All files are served as-is.

## Pages

| File | Role |
|------|------|
| `index.html` | Top page (hero, renewal notice, exhibition, news grid, shop info, contact) |
| `preopen.html` | Pre-opening details (message, shop info, interior photos, access) |
| `renewal.html` | New store opening announcement |
| `news.html` | News list — JS-rendered from `NEWS_ARTICLES` in `lang.js` |
| `onlineshop.html` | Online shop placeholder (coming soon) |
| `products.html` | All-products grid with tab UI (商品別/作家別) |
| `product.html` | Single product detail template — reads `?id=ITEM_ID` URL param |
| `akarinouta2026.html` | Exhibition page — vickey'72「灯の詩」 (full content) |

Individual product HTML files exist for all products: 8 custom-named (`product_katayama_futamono.html` etc.) + 131 generated (`product_{BASE_ID}.html`).

## Multilingual System

All pages include `<script src="lang.js"></script>`. Language preference stored in `localStorage` under `arc_lang`.

**Key globals in `lang.js`:**
- `LANG_TRANSLATIONS` — `{ ja, en, zh }`, each containing all translatable strings keyed by `data-i18n` values
- `NEWS_ARTICLES` — `{ ja, en, zh }` arrays of news objects
- `setLang(lang)` — swaps all `[data-i18n]` content, updates `[data-i18n-placeholder]` on inputs, rebuilds news grid, calls `applyProductTranslations(lang)`, then calls `window.onLangChange(lang)` if defined
- `initLang()` — reads `localStorage` and calls `setLang()`, runs on `DOMContentLoaded`
- `applyProductTranslations(lang)` — applies product-specific translations from `PRODUCT_TRANSLATIONS` to `.product-title`, `.product-desc p`, `.artist-profile-text`, and spec value cells (identified as the `nextElementSibling` of `[data-i18n="spec_*"]` labels)

**To add a translatable UI string:**
1. Add `data-i18n="my_key"` to the HTML element
2. Add `my_key: "..."` to all three language objects in `lang.js`

### Product Page Translation System

Product-specific content (descriptions, spec values, artist profiles) is translated via **`product_translations.js`** — a separate file keyed by HTML filename:

```js
window.PRODUCT_TRANSLATIONS = {
  'product_84294099.html': {
    en: { name: "...", desc: "...", artist_profile: "...", specs: { material: "...", care: "..." } },
    zh: { ... }
  }
}
```

- All static product pages (`product_*.html`) load `product_translations.js` **before** `lang.js`
- `lang.js`'s `applyProductTranslations` stores the original Japanese DOM text on first call (`_productOrigCache`) and uses it to restore when switching back to Japanese
- `product.html` (dynamic) defines `window.onLangChange` after render to handle subsequent language switches; it calls its own `applyDynamicProductLang()` which re-applies `data-i18n` labels and looks up `PRODUCT_TRANSLATIONS['product_' + id + '.html']`

**To add translations for a new product:** append an entry to `product_translations.js` under the product's filename key. No other files need changes.

## Password Protection

Pages with a password overlay: `index.html`, `renewal.html`, `news.html`, `akarinouta2026.html`.  
Password: `arcfukameki2026` — stored in `sessionStorage` under `arc_auth`.

## Product Data Architecture

### Data files
- **`products_data.js`** — `window.PRODUCTS_DATA`, flat object keyed by BASE item ID. Append new entries before `}; // END PRODUCTS_DATA`
- **`artists_data.js`** — `window.ARTISTS_DATA`, keyed by artist name (Japanese). Each: `{ bio: "...\n...", photo?: "path" }`. Bio uses `\n` for line breaks.
- **`product_translations.js`** — `window.PRODUCT_TRANSLATIONS`, EN/ZH translations for product-specific content, keyed by HTML filename

Each `PRODUCTS_DATA` entry:
```js
{
  artist, name, price, category,
  size, material, care,   // optional
  description,
  img,          // local first image: "photo/index/p{ID}_01.jpg"
  images,       // array of CDN hash strings (not full URLs)
  baseUrl       // https://fukameki.thebase.in/items/{ID}
}
```

CDN image URL pattern: `https://baseec-img-mng.akamaized.net/images/item/origin/{hash}.jpg`

Valid `category` values: `Ceramics`, `Glass`, `Woodwork`, `Fabric`, `Lighting`, `Paper`, `Other`

### products.html tab UI

Two tabs: **商品別** (full grid, `#products-grid`) and **作家別** (artist filter buttons → `#artist-spotlight` + filtered cards). The artist spotlight uses `style="display:none"` — `filterByArtist()` must set `spotlight.style.display = 'block'` (not `''`). Artist names are extracted from `.product-cat` text nodes in the DOM.

### To add a new product from BASE shop
1. Fetch the BASE product page to get name, price, description, specs, and image hash list
2. Download the first image: save to `photo/index/p{ID}_01.jpg`
3. Compress if over 400KB (max 1200px wide, quality 82 JPEG)
4. Append an entry to `PRODUCTS_DATA` in `products_data.js`
5. Generate `product_{ID}.html` (copy structure from `product_katayama_futamono.html`) — include `.artist-profile` section if bio exists in `artists_data.js`
6. Add a `.product-card` `<a>` to `products.html` pointing to `product_{ID}.html`
7. Append EN/ZH translations to `product_translations.js`

### Soldout products
In `products.html`: add `<span class="soldout-label">（soldout）</span>` after the product name.  
In `product_{ID}.html`: add `<p class="soldout-badge">（soldout）</p>` after `<h1>`.

## Image Management

All images live under `photo/index/`:
- `p{ID}_01.jpg` — product first images (local copy of BASE CDN image)
- `akari_img01.jpg` – `akari_img06.jpg` — exhibition artwork photos
- Store renovation photos in `photo/0329/`

Mobile performance: keep `p{ID}_01.jpg` under 400KB.
```python
from PIL import Image
img = Image.open(path)
if img.width > 1200:
    img = img.resize((1200, int(img.height * 1200 / img.width)), Image.LANCZOS)
img.save(path, 'JPEG', quality=82, optimize=True)
```

## Design Conventions

- **Fonts:** `EB Garamond` (headings, labels, links) + `Noto Serif JP` (body), from Google Fonts
- **CSS variables:** `--black`, `--off-black`, `--dark-gray`, `--mid-gray`, `--light-gray`, `--off-white`, `--white`, `--border`
- **Scroll reveal:** class `reveal` + `IntersectionObserver` adds `.visible`. Do **not** put `reveal` on large containers.
- **Nav — top page:** fixed, full links + lang-switcher + hamburger
- **Nav — subpages:** logo + lang-switcher + back link (`data-i18n="nav_back"`)
- **Responsive breakpoints:** 960px (nav collapse), 600px (single-column)
- **Product card images:** `position: relative; padding-top: 133.33%; overflow: hidden` on `.product-image` with `position: absolute; top:0; left:0; width:100%; height:100%; object-fit:cover` on `img`. Do **not** use `aspect-ratio` on the container — unreliable on older mobile Safari.

## Adding a New Exhibition Page

Copy `ampiana2026.html` (coming soon) or `akarinouta2026.html` (full content). Ensure:
- Simplified subpage nav with lang-switcher
- `data-i18n` on all Japanese text
- New translation keys in all three language objects in `lang.js`
- `<script src="lang.js"></script>` before `</body>`

## Naming Conventions

- Store name: **ARC FUKAMEKI minoh** (all caps, lowercase "minoh")
- Artist: **vickey'72** (always lowercase "v")
