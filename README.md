# Shopify Collection Page – Featured Products + Infinite Scroll

## Overview
This project implements a Shopify collection page with:
- Featured products pinned at the top
- Infinite scroll (20 products per load)
- Shopify-native filtering and sorting support
- No duplicate products across pagination
- Safe handling of featured products across multiple pages

Built using **Shopify Liquid** + **Vanilla JavaScript** (`IntersectionObserver` + Fetch API).

## Key Features

### 1. Featured Products on Top
- Products tagged with `feature_product` are always shown first.
- Exactly 15 featured products are supported (can scale).
- Featured products are extracted from both:
  - Initial Liquid render
  - Additional Shopify pagination pages

### 2. Infinite Scroll (20 Products per Load)
- Uses `IntersectionObserver` with a sentinel loader.
- Loads products in chunks of 20 items.
- Prevents multiple simultaneous requests using `isLoading` flag.
- Smooth, buffer-based rendering for performance.

### 3. Duplicate Prevention
To ensure no product repetition:
- `featuredProductIds` → tracks all featured products.
- `renderedProductIds` → ensures global uniqueness across DOM.

This prevents:
- Featured products reappearing in scroll pages.
- Duplicate products from Shopify pagination.

### 4. Initial Load Logic
On first page load:
- **Liquid renders:**
  - Featured products (Pass 1)
  - Non-featured products (Pass 2)
- **JavaScript:**
  - Moves all featured products to top.
  - Shows remaining slots up to 20 total products.
  - Stores extra products in buffer for infinite scroll.

**Final output:** Featured products + remaining non-featured products = 20 initial items.

### 5. Infinite Scroll Flow
When user scrolls:
1. Check buffer availability.
2. If buffer is low → fetch next Shopify page.
3. Parse HTML using `DOMParser`.
4. Remove featured products from scroll stream.
5. Add only non-featured products to buffer.
6. Render next 20 products.

### 6. Handling Featured Products from Later Pages
**Issue:** Shopify pagination may include featured products in page 2+.
**Solution:**
- Every fetched page is scanned.
- Featured products are detected using tag + ID.
- They are added to featured set but NOT rendered again.

### 7. Filtering & Sorting Support
When filters or sorting is applied:
- Featured logic is disabled automatically.
- Shopify default behavior takes over.
- Infinite scroll still works normally.
- `MutationObserver` re-initializes script after DOM replacement.

**Modes:**

| Mode | Behavior |
|------|----------|
| Default collection view | Featured pinned + custom logic |
| Filtered view | Shopify default |
| Sorted view | Shopify default |

### 8. Edge Cases Handled
- **No Featured Products:** System falls back to normal infinite scroll.
- **Featured products only on later pages:** Fetched via tagged collection request.
- **Pagination end:** Sentinel is hidden when `nextUrl = null`.
- **Shopify AJAX filter reload:** `MutationObserver` reinitializes the script safely.

### 9. Performance Considerations
- Uses HTML section fetching (not heavy APIs).
- Buffer-based rendering avoids DOM thrashing.
- `IntersectionObserver` instead of scroll events.
- `AbortController` prevents memory leaks.
- Minimal reflows during pagination.

### 10. Shopify Limitations & Solutions

| Limitation | Solution |
|------------|----------|
| No API for collection filtering by tag | Used section HTML fetch |
| Pagination duplicates possible | Global ID tracking |
| Liquid cannot reorder across pages | JS post-processing layer |
| AJAX filter replaces DOM | `MutationObserver` re-init |

## Core State Variables
- `featuredProductIds` — Stores all featured product IDs
- `renderedProductIds` — Prevents duplicate rendering
- `nonFeaturedBuffer` — Stores scroll-ready products
- `nextUrl` — Shopify pagination URL
- `isLoading` — Prevents concurrent fetch calls

## Infinite Scroll Strategy
- `IntersectionObserver` watches sentinel.
- `rootMargin: 400px` (preloads early).
- Fetch triggered before user reaches bottom.
- Products rendered in controlled batches (20 items).
