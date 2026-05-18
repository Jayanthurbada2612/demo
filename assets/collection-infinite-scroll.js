let infiniteScrollInstance = null;

class CollectionInfiniteScroll {
  constructor() {
    this.grid = document.getElementById('product-grid');
    if (!this.grid) return;

    this.sentinel = document.getElementById('infinite-scroll-sentinel');
    this.fallback = document.getElementById('pagination-fallback');
    this.collectionUrl = this.grid.dataset.collectionUrl || window.location.pathname;

    this.chunkSize = 20;
    this.buffer = [];
    this.renderedProductIds = new Set();
    this.isLoading = false;
    this.observer = null;

    this.nextUrl = this.sentinel ? this.sentinel.dataset.nextUrl : null;
    this.isFilteredOrSorted = this.checkIfFilteredOrSorted();

    // Hide fallback pagination if JS is active
    if (this.fallback) this.fallback.style.display = 'none';

    this.init();
  }

  checkIfFilteredOrSorted() {
    const params = new URLSearchParams(window.location.search);
    for (const key of params.keys()) {
      if (key === 'sort_by' || key.startsWith('filter.')) {
        return true;
      }
    }
    return false;
  }

  async init() {
    if (this.sentinel) this.sentinel.style.display = 'none';

    // Extract initially rendered products and detach them safely to preserve event listeners
    const initialItems = Array.from(this.grid.querySelectorAll('.grid__item'));
    initialItems.forEach(item => {
      const id = item.dataset.productId;
      if (id) {
        this.buffer.push({ id, element: item });
      }
      if (item.parentNode) {
        item.parentNode.removeChild(item);
      }
    });

    // Clear any remaining nodes (like empty text nodes)
    this.grid.innerHTML = '';

    if (!this.isFilteredOrSorted) {
      // Default state: Fetch 15 featured products and prepend to buffer
      await this.fetchFeaturedProducts();
    }

    // Deduplicate the buffer (in case featured products were in the initial batch)
    this.deduplicateBuffer();

    // Render the initial 20 items (15 featured + 5 normal)
    this.renderNextChunk(this.chunkSize);

    this.setupObserver();
  }

  async fetchFeaturedProducts() {
    try {
      // URL routes to our api endpoint to get just the featured products
      const url = `${this.collectionUrl}/featured_product?section_id=featured-products-api`;
      const response = await fetch(url);
      if (!response.ok) throw new Error('Featured products fetch failed');
      const html = await response.text();

      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');
      const featuredItems = Array.from(doc.querySelectorAll('.grid__item'));

      const featuredBuffer = featuredItems.map(item => ({
        id: item.dataset.productId,
        element: item
      }));

      // Prepend featured products to the buffer
      this.buffer = [...featuredBuffer, ...this.buffer];
    } catch (error) {
      console.error('Antigravity Theme: Error fetching featured products:', error);
    }
  }

  deduplicateBuffer() {
    const uniqueIds = new Set();
    const deduplicated = [];

    // Prioritize items that appear earlier (featured ones are first)
    for (const item of this.buffer) {
      if (!uniqueIds.has(item.id)) {
        uniqueIds.add(item.id);
        deduplicated.push(item);
      }
    }
    this.buffer = deduplicated;
  }

  renderNextChunk(count) {
    let rendered = 0;

    while (rendered < count && this.buffer.length > 0) {
      const item = this.buffer.shift();
      // Double check global Set to avoid rendering same product across pages
      if (!this.renderedProductIds.has(item.id)) {
        this.grid.appendChild(item.element);
        this.renderedProductIds.add(item.id);
        rendered++;
      }
    }

    this.updateSentinelVisibility();
  }

  updateSentinelVisibility() {
    if (!this.sentinel) return;

    if (this.nextUrl || this.buffer.length > 0) {
      this.sentinel.style.display = 'flex';
    } else {
      this.sentinel.style.display = 'none';
    }
  }

  setupObserver() {
    if (!this.sentinel) return;

    const options = {
      root: null,
      rootMargin: '400px', // start fetching 400px before reaching the bottom
      threshold: 0.1
    };

    this.observer = new IntersectionObserver(this.handleIntersect.bind(this), options);
    this.observer.observe(this.sentinel);
  }

  async handleIntersect(entries) {
    const entry = entries[0];
    if (entry.isIntersecting && !this.isLoading) {
      if (this.buffer.length >= this.chunkSize) {
        // We have enough buffered items to render a chunk instantly
        this.renderNextChunk(this.chunkSize);
      } else if (this.nextUrl) {
        // Fetch the next Shopify pagination page
        await this.fetchNextPage();
        this.renderNextChunk(this.chunkSize);
      } else if (this.buffer.length > 0) {
        // Flush remaining buffer
        this.renderNextChunk(this.buffer.length);
      }
    }
  }

  async fetchNextPage() {
    this.isLoading = true;
    try {
      const response = await fetch(this.nextUrl);
      if (!response.ok) throw new Error('Pagination fetch failed');
      const html = await response.text();

      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      const newItems = Array.from(doc.querySelectorAll('#product-grid .grid__item'));

      newItems.forEach(item => {
        const id = item.dataset.productId;
        if (id) {
          this.buffer.push({ id, element: item });
        }
      });

      this.deduplicateBuffer();

      // Update next URL from the newly fetched page
      const newSentinel = doc.getElementById('infinite-scroll-sentinel');
      if (newSentinel && newSentinel.dataset.nextUrl) {
        this.nextUrl = newSentinel.dataset.nextUrl;
      } else {
        this.nextUrl = null;
      }
    } catch (error) {
      console.error('Antigravity Theme: Error fetching next page:', error);
    } finally {
      this.isLoading = false;
    }
  }

  destroy() {
    if (this.observer && this.sentinel) {
      this.observer.unobserve(this.sentinel);
    }
  }
}

function initInfiniteScroll() {
  if (infiniteScrollInstance) {
    infiniteScrollInstance.destroy();
  }
  infiniteScrollInstance = new CollectionInfiniteScroll();
}

document.addEventListener('DOMContentLoaded', () => {
  initInfiniteScroll();

  // Watch for OS 2.0 Facet updates that replace the grid HTML
  const container = document.getElementById('ProductGridContainer');
  if (container) {
    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.addedNodes.length > 0) {
          // Verify if #product-grid was part of the injected DOM
          const hasGrid = Array.from(mutation.addedNodes).some(node => 
            node.id === 'product-grid' || (node.querySelector && node.querySelector('#product-grid'))
          );
          
          if (hasGrid) {
            initInfiniteScroll();
            break;
          }
        }
      }
    });
    
    mutationObserver.observe(container, { childList: true, subtree: true });
  }
});
