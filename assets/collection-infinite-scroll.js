'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const FEATURED_TAG = 'feature_product';
const INITIAL_VISIBLE = 20; // Total products shown on first paint
const SCROLL_CHUNK = 20; // Products added per infinite-scroll trigger
const SENTINEL_MARGIN = '400px'; // How far before the sentinel to start fetching

// ─── Module-level instance ────────────────────────────────────────────────────

let instance = null;

// ─── Class ────────────────────────────────────────────────────────────────────

class CollectionInfiniteScroll {
  constructor() {
    this.grid = document.getElementById('product-grid');
    this.sentinel = document.getElementById('infinite-scroll-sentinel');
    this.fallback = document.getElementById('pagination-fallback');

    if (!this.grid) return;

    // Read config baked into the DOM by Liquid so JS never hard-codes store specifics
    this.collectionUrl = this.grid.dataset.collectionUrl || window.location.pathname;
    this.sectionId = this.grid.dataset.id;
    this.isDefaultView = this.grid.dataset.isDefaultView === 'true';

    // The URL of the next Shopify pagination page (null = no more pages)
    // Use || null (not ??) so an empty string from the last Shopify page
    // (paginate.next.url is blank when there is no next page) collapses to null.
    this.nextUrl = this.sentinel?.dataset.nextUrl || null;

    // ── State ──────────────────────────────────────────────────────────────────
    //
    // featuredProductIds  — IDs that must NEVER appear in the normal scroll stream.
    //                       Populated during init; checked on every page fetch.
    //
    // renderedProductIds  — Global dedup guard. Ensures a product is never
    //                       appended to the DOM twice, regardless of which
    //                       Shopify pagination page it appears on.
    //
    // nonFeaturedBuffer   — Queue of non-featured <li> nodes waiting to be
    //                       rendered. Filled by fetchNextPage(); drained by
    //                       renderFromBuffer(). Featured products fetched from
    //                       later pages are discarded here, never buffered.

    this.featuredProductIds = new Set();
    this.renderedProductIds = new Set();
    this.nonFeaturedBuffer = [];

    // isLoading is set to true for the entire duration of handleIntersect so
    // the IntersectionObserver cannot trigger concurrent fetches.
    this.isLoading = false;

    this.observer = null;

    // AbortController lets destroy() cancel any in-flight fetch when Shopify's
    // facets AJAX replaces the grid and triggers a fresh instance.
    this.abortController = new AbortController();

    // Hide the fallback pagination; we drive pagination via IntersectionObserver
    if (this.fallback) this.fallback.style.display = 'none';

    // Kick off async init; catch ensures the grid is always revealed on failure
    this.init().catch((err) => {
      console.error('[CRG] Init failed, falling back to server-rendered order:', err);
      this._revealGrid();
    });
  }

  // ── Initialisation ───────────────────────────────────────────────────────────

  async init() {
    // Hide sentinel while we set up to prevent the IntersectionObserver from
    // firing before the grid is in its final state.
    if (this.sentinel) this.sentinel.style.display = 'none';

    if (this.isDefaultView) {
      await this._initDefaultView();
    } else {
      this._initFilteredView();
    }

    this._setupObserver();
  }

  // ── Default view (featured pinning active) ───────────────────────────────────

  async _initDefaultView() {
    // Phase 1 ─ hide the server-rendered grid while we reorder.
    // The CSS rule for .crg-featured-loading uses visibility:hidden + min-height
    // so the page doesn't collapse, preventing the sentinel from entering the
    // viewport too early and triggering an unwanted page-2 fetch.
    this.grid.classList.add('crg-featured-loading');

    // Phase 2 ─ split the Liquid-rendered items into featured / non-featured.
    // The two-pass Liquid render guarantees featured items appear first in the
    // DOM and already have their custom elements (quick-add, etc.) initialised.
    const initialFeatured = [];
    const initialNonFeatured = [];

    Array.from(this.grid.querySelectorAll('.grid__item[data-product-id]')).forEach((li) => {
      li.remove(); // detach without destroying event listeners
      if (li.dataset.isFeatured === 'true') {
        initialFeatured.push(li);
        this.featuredProductIds.add(li.dataset.productId);
      } else {
        initialNonFeatured.push(li);
      }
    });

    // Phase 3 ─ fetch ALL featured products.
    // Shopify's tagged collection URL (/collections/handle/TAG) limits results to
    // products carrying that tag within the collection. Adding ?section_id= returns
    // only the section HTML rather than the full page, making this lightweight.
    // This call is what fixes the core bug in the original code: the old endpoint
    // (/featured_product?section_id=featured-products-api) does not exist in Shopify.
    const allFeatured = await this._fetchAllFeatured(initialFeatured);

    // Phase 4 ─ determine how many non-featured slots we need on the first screen.
    // If all 15 featured exist: show 15 featured + 5 non-featured = 20.
    // If fewer featured exist: fill the remaining slots with non-featured.
    // If zero featured exist: normal 20-product display.
    const nonFeaturedNeeded = Math.max(0, INITIAL_VISIBLE - allFeatured.length);

    // Phase 5 ─ clear and rebuild the grid in correct order.
    this.grid.innerHTML = '';

    allFeatured.forEach((li) => {
      this.grid.appendChild(li);
      this.renderedProductIds.add(li.dataset.productId);
    });

    let shown = 0;
    const remaining = [];

    for (const li of initialNonFeatured) {
      const id = li.dataset.productId;
      if (this.renderedProductIds.has(id)) continue; // already rendered as featured (shouldn't happen, but safe)
      if (shown < nonFeaturedNeeded) {
        this.grid.appendChild(li);
        this.renderedProductIds.add(id);
        shown++;
      } else {
        remaining.push(li);
      }
    }

    // Non-featured products from the initial Shopify page that weren't shown
    // immediately go into the buffer for the first infinite-scroll trigger.
    remaining.forEach((li) => {
      if (!this.featuredProductIds.has(li.dataset.productId)) {
        this.nonFeaturedBuffer.push(li);
      }
    });

    // Phase 6 ─ reveal
    this._revealGrid();
    this._updateSentinel();
  }

  // Fetches the tagged collection URL via Shopify section rendering to get ALL
  // featured products across all Shopify pagination pages. Merges with any
  // featured products already present in the server-rendered DOM (which have
  // working event listeners and don't need re-hydration).
  //
  // Why section rendering instead of the JSON API?
  //   The JSON API (/products.json) doesn't support tag filtering within a
  //   specific collection. The section rendering approach returns the same HTML
  //   that Liquid would render, preserving all theme markup and custom elements.
  async _fetchAllFeatured(initialFeatured) {
    // Index the initial featured elements by ID so we can prefer them over
    // freshly-fetched nodes (they already have event listeners attached).
    const byId = new Map(initialFeatured.map((li) => [li.dataset.productId, li]));

    let fetchUrl = `${this.collectionUrl}/${FEATURED_TAG}?section_id=${this.sectionId}`;
    const extraFeatured = []; // featured found on Shopify pages 2+

    try {
      while (fetchUrl) {
        const response = await fetch(fetchUrl, {
          signal: this.abortController.signal,
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });

        if (!response.ok) {
          console.warn(`[CRG] Featured fetch returned ${response.status} — using page-1 featured only`);
          break;
        }

        const html = await response.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const items = Array.from(doc.querySelectorAll('#product-grid .grid__item[data-product-id]'));

        for (const li of items) {
          const id = li.dataset.productId;
          this.featuredProductIds.add(id);
          // Only collect this node if it was NOT in the initial server render.
          // We'll merge with initial nodes in the correct order below.
          if (!byId.has(id)) {
            extraFeatured.push(li);
          }
        }

        // Paginate through the tagged collection in case there are ever more
        // than products_per_page featured products (future-proofing beyond 15).
        const nextSentinel = doc.getElementById('infinite-scroll-sentinel');
        const rawNext = nextSentinel?.dataset.nextUrl ?? null;
        // Append section_id so each subsequent page also returns only section HTML
        fetchUrl = rawNext ? `${rawNext}&section_id=${this.sectionId}` : null;
      }
    } catch (err) {
      if (err.name === 'AbortError') return initialFeatured; // clean shutdown, not an error
      console.warn('[CRG] Featured fetch error — using page-1 featured only:', err);
    }

    // Final merge order:
    //   1. Initial DOM featured nodes (have working event listeners — prioritise them)
    //   2. Freshly fetched featured nodes from Shopify pages 2+
    return [...initialFeatured, ...extraFeatured];
  }

  // ── Filtered / sorted view (no featured pinning) ─────────────────────────────

  _initFilteredView() {
    // Products are already in the correct server-rendered order. Just seed the
    // rendered-IDs set so infinite scroll deduplication works from the start.
    this.grid.querySelectorAll('.grid__item[data-product-id]').forEach((li) => {
      this.renderedProductIds.add(li.dataset.productId);
    });
    this._updateSentinel();
  }

  // ── IntersectionObserver ─────────────────────────────────────────────────────

  _setupObserver() {
    if (!this.sentinel) return;

    this.observer = new IntersectionObserver(this._handleIntersect.bind(this), {
      root: null,
      rootMargin: SENTINEL_MARGIN,
      threshold: 0,
    });

    this.observer.observe(this.sentinel);
  }

  // The isLoading flag is set for the ENTIRE duration of this handler.
  // This is the single concurrency gate — sub-methods never touch isLoading.
  async _handleIntersect(entries) {
    if (!entries[0].isIntersecting || this.isLoading) return;

    // Nothing left to show — sentinel should already be hidden by _updateSentinel,
    // but guard here in case the observer fires one extra time after the last render.
    const nothingLeft = !this.nextUrl
      && (!this.isDefaultView || this.nonFeaturedBuffer.length === 0);
    if (nothingLeft) return;

    this.isLoading = true;
    this.sentinel.style.display = 'flex'; // show spinner while working

    try {
      if (this.isDefaultView) {
        await this._scrollDefaultView();
      } else {
        await this._scrollFilteredView();
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        console.error('[CRG] Scroll fetch failed:', err);
      }
    } finally {
      this.isLoading = false;
      this._updateSentinel();
    }
  }

  // ── Default view scroll handler ───────────────────────────────────────────────

  async _scrollDefaultView() {
    // If the buffer already has a full chunk, render immediately — no fetch needed.
    if (this.nonFeaturedBuffer.length >= SCROLL_CHUNK) {
      this._renderFromBuffer(SCROLL_CHUNK);
      return;
    }

    if (this.nextUrl) {
      // Fetch the next Shopify page and push non-featured products into the buffer.
      // Featured products encountered here are silently discarded.
      await this._fetchNextPageIntoBuffer();
      this._renderFromBuffer(SCROLL_CHUNK);
    } else if (this.nonFeaturedBuffer.length > 0) {
      // Last partial chunk — flush whatever is left
      this._renderFromBuffer(this.nonFeaturedBuffer.length);
    }
  }

  // Fetches the next Shopify pagination page and appends ONLY non-featured
  // products to the buffer. Featured products are discarded here because they
  // were already rendered at the top of the grid during init.
  //
  // Why not render directly? The buffer decouples fetching from rendering,
  // which means we always render full SCROLL_CHUNK batches (or the final
  // partial batch). This prevents the "show 3 products, fetch, show 3 more"
  // stutter that occurs when many products on a page are featured and filtered out.
  async _fetchNextPageIntoBuffer() {
    const response = await fetch(this.nextUrl, {
      signal: this.abortController.signal,
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });

    if (!response.ok) throw new Error(`[CRG] Page fetch returned ${response.status}`);

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    Array.from(doc.querySelectorAll('#product-grid .grid__item[data-product-id]')).forEach((li) => {
      const id = li.dataset.productId;

      // Skip featured — they live at the top, never in the scroll stream
      if (this.featuredProductIds.has(id)) return;
      // Skip already-rendered (covers edge case where same product exists in
      // multiple Shopify pages due to collection membership changes mid-session)
      if (this.renderedProductIds.has(id)) return;

      this.nonFeaturedBuffer.push(li);
    });

    this.nextUrl = this._extractNextUrl(doc);
  }

  // ── Filtered view scroll handler ──────────────────────────────────────────────

  // In filtered/sorted mode there is no featured pinning. Products are rendered
  // directly from each fetched page with global dedup as the only safeguard.
  async _scrollFilteredView() {
    if (!this.nextUrl) return;

    const response = await fetch(this.nextUrl, {
      signal: this.abortController.signal,
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });

    if (!response.ok) throw new Error(`[CRG] Page fetch returned ${response.status}`);

    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    Array.from(doc.querySelectorAll('#product-grid .grid__item[data-product-id]')).forEach((li) => {
      const id = li.dataset.productId;
      if (this.renderedProductIds.has(id)) return;
      this.grid.appendChild(li);
      this.renderedProductIds.add(id);
    });

    this.nextUrl = this._extractNextUrl(doc);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  _renderFromBuffer(count) {
    let rendered = 0;
    while (rendered < count && this.nonFeaturedBuffer.length > 0) {
      const li = this.nonFeaturedBuffer.shift();
      const id = li.dataset.productId;
      // Final dedup check: a product could theoretically appear in the buffer
      // AND be fetched again if Shopify's pagination shifts (e.g. product added
      // to collection between page loads).
      if (this.renderedProductIds.has(id)) continue;
      this.grid.appendChild(li);
      this.renderedProductIds.add(id);
      rendered++;
    }
  }

  _extractNextUrl(doc) {
    // || null converts an empty string (last Shopify page has data-next-url="")
    // to null so _updateSentinel correctly hides the spinner when done.
    return doc.getElementById('infinite-scroll-sentinel')?.dataset.nextUrl || null;
  }

  // Show the sentinel when there is more content to load; hide it when done.
  // For the default view, "more content" means either a non-empty buffer or a
  // remaining Shopify page. For the filtered view, only a remaining page matters.
  _updateSentinel() {
    if (!this.sentinel) return;
    const hasMore = this.nextUrl !== null
      || (this.isDefaultView && this.nonFeaturedBuffer.length > 0);
    this.sentinel.style.display = hasMore ? 'flex' : 'none';
  }

  _revealGrid() {
    this.grid.classList.remove('crg-featured-loading');
  }

  // Called before re-init so the stale instance releases resources and cancels
  // any in-flight requests that would otherwise write to a replaced DOM.
  destroy() {
    this.abortController.abort();
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

function initInfiniteScroll() {
  if (instance) instance.destroy();
  instance = new CollectionInfiniteScroll();
}

document.addEventListener('DOMContentLoaded', () => {
  initInfiniteScroll();

  // Shopify's Facets JS (facets.js) replaces the entire #ProductGridContainer
  // innerHTML via AJAX when the user changes a filter or sort option. The
  // MutationObserver detects this replacement and re-initialises infinite scroll
  // with the fresh grid, which will have is_default_view correctly set by Liquid
  // based on the new URL parameters.
  const container = document.getElementById('ProductGridContainer');
  if (!container) return;

  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      const gridReplaced = Array.from(mutation.addedNodes).some(
        (node) =>
          node.nodeType === Node.ELEMENT_NODE &&
          (node.id === 'product-grid' || node.querySelector?.('#product-grid'))
      );
      if (gridReplaced) {
        initInfiniteScroll();
        break;
      }
    }
  }).observe(container, { childList: true, subtree: true });
});
