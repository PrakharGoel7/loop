import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { categories, products } from './catalog'
import type { Category, Product, Size } from './catalog'
import heroImage from './assets/hero.jpg'
import './StorePage.css'

type View = 'home' | 'listing' | 'product' | 'bag' | 'checkout' | 'complete'
type CartItem = { productId: string; size: Size; quantity: number }
type SortOrder = 'featured' | 'price-low' | 'price-high'

const money = (amount: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount)

function BagIcon({ size = 22 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4.5 8.5h15l-1 12h-13l-1-12Z" /><path d="M8.5 9V6a3.5 3.5 0 0 1 7 0v3" /></svg>
}

function SearchIcon({ size = 20 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.4" /><path d="m16 16 4.4 4.4" /></svg>
}

function ArrowIcon({ direction = 'right' }: { direction?: 'right' | 'left' }) {
  return <svg width="19" height="19" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={direction === 'left' ? { transform: 'rotate(180deg)' } : undefined}><path d="M2.5 10h14M11 4.5l5.5 5.5-5.5 5.5" /></svg>
}

function CloseIcon() {
  return <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M4 4l12 12M16 4 4 16" /></svg>
}

function loadCart(key: string): CartItem[] {
  try {
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((item): item is CartItem =>
      typeof item === 'object' && item !== null && typeof item.productId === 'string' && typeof item.size === 'string' && typeof item.quantity === 'number') : []
  } catch {
    return []
  }
}

export default function StorePage() {
  const sessionId = useMemo(() => new URLSearchParams(window.location.search).get('session') ?? '', [])
  const cartKey = `mira-cart-${sessionId || 'demo'}`
  const initialProduct = useMemo(() => {
    const id = new URLSearchParams(window.location.search).get('product')
    return products.find((product) => product.id === id) ?? null
  }, [])

  const [view, setView] = useState<View>(initialProduct ? 'product' : 'home')
  const [category, setCategory] = useState<Category | 'All'>('All')
  const [searchDraft, setSearchDraft] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortOrder>('featured')
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(initialProduct)
  const [selectedSize, setSelectedSize] = useState<Size | null>(null)
  const [cart, setCart] = useState<CartItem[]>(() => loadCart(cartKey))
  const [quantity, setQuantity] = useState(1)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [checkoutEmail, setCheckoutEmail] = useState('')

  useEffect(() => {
    localStorage.setItem(cartKey, JSON.stringify(cart))
  }, [cart, cartKey])

  const track = (type: string, detail: Record<string, unknown> = {}) => {
    if (!sessionId) return
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, detail, timestamp: new Date().toISOString() }),
      keepalive: true,
    }).catch(() => undefined)
  }

  useEffect(() => {
    if (!sessionId) return
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'store_opened', detail: { path: window.location.pathname }, timestamp: new Date().toISOString() }),
      keepalive: true,
    }).catch(() => undefined)
  }, [sessionId])

  const scrollTop = () => window.scrollTo({ top: 0, behavior: 'smooth' })
  const clearProductParam = () => {
    const url = new URL(window.location.href)
    url.searchParams.delete('product')
    window.history.replaceState({}, '', url)
  }

  const goHome = () => {
    clearProductParam()
    setView('home')
    setCategory('All')
    setQuery('')
    setSearchDraft('')
    setMobileMenuOpen(false)
    track('home_viewed')
    scrollTop()
  }

  const openListing = (nextCategory: Category | 'All' = 'All', nextQuery = '') => {
    clearProductParam()
    setCategory(nextCategory)
    setQuery(nextQuery)
    setSearchDraft(nextQuery)
    setView('listing')
    setMobileMenuOpen(false)
    track('listing_viewed', { category: nextCategory, query: nextQuery })
    scrollTop()
  }

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalized = searchDraft.trim()
    track('search_submitted', { query: normalized, from: view })
    openListing('All', normalized)
  }

  const openProduct = (product: Product) => {
    const url = new URL(window.location.href)
    url.searchParams.set('product', product.id)
    window.history.replaceState({}, '', url)
    setSelectedProduct(product)
    setSelectedSize(null)
    setQuantity(1)
    setView('product')
    track('product_viewed', { productId: product.id, productName: product.name, category: product.category, color: product.color })
    scrollTop()
  }

  const chooseSize = (size: Size) => {
    setSelectedSize(size)
    if (selectedProduct) track('size_selected', { productId: selectedProduct.id, size, previousSize: selectedSize })
  }

  const addToBag = () => {
    if (!selectedProduct) return
    if (!selectedSize) {
      track('add_to_bag_without_size', { productId: selectedProduct.id })
      document.getElementById('mira-size-choices')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    setCart((items) => {
      const match = items.find((item) => item.productId === selectedProduct.id && item.size === selectedSize)
      if (match) return items.map((item) => item === match ? { ...item, quantity: item.quantity + quantity } : item)
      return [...items, { productId: selectedProduct.id, size: selectedSize, quantity }]
    })
    track('added_to_bag', { productId: selectedProduct.id, size: selectedSize, quantity })
    setView('bag')
    scrollTop()
  }

  const updateCart = (productId: string, size: Size, nextQuantity: number) => {
    setCart((items) => nextQuantity <= 0
      ? items.filter((item) => !(item.productId === productId && item.size === size))
      : items.map((item) => item.productId === productId && item.size === size ? { ...item, quantity: nextQuantity } : item))
    track(nextQuantity <= 0 ? 'bag_item_removed' : 'bag_quantity_changed', { productId, size, quantity: nextQuantity })
  }

  const cartCount = cart.reduce((sum, item) => sum + item.quantity, 0)
  const subtotal = cart.reduce((sum, item) => sum + (products.find((product) => product.id === item.productId)?.price ?? 0) * item.quantity, 0)
  const shipping = subtotal >= 100 ? 0 : 8

  const listedProducts = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const filtered = products.filter((product) => {
      if (category !== 'All' && product.category !== category) return false
      if (!terms.length) return true
      const searchable = [product.name, product.category, product.category.slice(0, -1), product.color, product.description, ...(product.keywords ?? [])].join(' ').toLowerCase()
      return terms.every((term) => searchable.includes(term))
    })
    if (sort === 'price-low') return [...filtered].sort((a, b) => a.price - b.price)
    if (sort === 'price-high') return [...filtered].sort((a, b) => b.price - a.price)
    return filtered
  }, [category, query, sort])

  const ProductCard = ({ product }: { product: Product }) => (
    <button type="button" className="mira-product-card" onClick={() => openProduct(product)} aria-label={`View ${product.name}, ${money(product.price)}`}>
      <span className="mira-product-image-wrap">
        <img src={product.image} alt={product.name} style={{ objectPosition: product.imagePosition }} loading="lazy" />
        {product.badge && <span className="mira-product-badge">{product.badge}</span>}
        <span className="mira-card-quick">Explore <ArrowIcon /></span>
      </span>
      <span className="mira-product-meta"><span>{product.category} <span className="mira-meta-dot">·</span> {product.color}</span><span>{money(product.price)}</span></span>
      <span className="mira-product-name">{product.name}</span>
    </button>
  )

  return <div className="mira-store">
    <div className="mira-announcement">A little more room for your kind of style <span>✳</span> Complimentary shipping on orders $100+</div>
    <header className="mira-header">
      <button type="button" className="mira-menu-button" onClick={() => setMobileMenuOpen((open) => !open)} aria-label="Toggle menu" aria-expanded={mobileMenuOpen}><span /><span /></button>
      <button type="button" className="mira-wordmark" onClick={goHome} aria-label="Mira home">mira<span>.</span></button>
      <nav className={`mira-nav ${mobileMenuOpen ? 'mira-nav-open' : ''}`} aria-label="Main navigation">
        <button type="button" onClick={() => openListing('All')}>Shop all</button>
        {categories.map((item) => <button key={item} type="button" onClick={() => openListing(item)}>{item}</button>)}
      </nav>
      <div className="mira-header-actions">
        <form className="mira-search" onSubmit={submitSearch} role="search">
          <input value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} placeholder="Search the collection" aria-label="Search the collection" />
          {searchDraft && <button type="button" className="mira-search-clear" onClick={() => setSearchDraft('')} aria-label="Clear search"><CloseIcon /></button>}
          <button type="submit" className="mira-search-submit" aria-label="Search"><SearchIcon /></button>
        </form>
        <button type="button" className="mira-bag-button" onClick={() => { setView('bag'); track('bag_viewed', { itemCount: cartCount }); scrollTop() }} aria-label={`Bag with ${cartCount} items`}><BagIcon /><span>{cartCount}</span></button>
      </div>
    </header>

    <main>
      {view === 'home' && <>
        <section className="mira-hero">
          <div className="mira-hero-copy">
            <span className="mira-eyebrow"><span className="mira-flower">✳</span> The everyday edit / 2026</span>
            <h1>Getting dressed<br />should feel <em>good.</em></h1>
            <p>Considered pieces for wherever the day takes you. Easy to wear, easy to make your own.</p>
            <button type="button" className="mira-primary-button" onClick={() => openListing('All')}>Explore the collection <ArrowIcon /></button>
            <span className="mira-hero-note">Thoughtfully made. Worn on repeat.</span>
          </div>
          <div className="mira-hero-visual">
            <img src={heroImage} alt="Curated contemporary clothing" />
            <div className="mira-hero-stamp">a wardrobe<br /><em>for living</em><span>↗</span></div>
          </div>
        </section>
        <section className="mira-editorial-strip"><span>Good things, worn often.</span><span>✳</span><span>Made for real life.</span><span>✳</span><span>Style on your terms.</span></section>
        <section className="mira-home-section">
          <div className="mira-section-heading"><div><span className="mira-eyebrow">01 / Your wardrobe starts here</span><h2>Find your thing.</h2></div><p>Easy essentials and fresh favorites, all in one place.</p></div>
          <div className="mira-category-grid">
            {categories.map((item, index) => {
              const featured = products.find((product) => product.category === item)!
              return <button type="button" className={`mira-category-card mira-category-${index}`} key={item} onClick={() => openListing(item)}><img src={featured.image} alt="" loading="lazy" /><span><strong>{item}</strong><ArrowIcon /></span></button>
            })}
          </div>
        </section>
        <section className="mira-home-section mira-featured-section">
          <div className="mira-section-heading"><div><span className="mira-eyebrow">02 / The pieces everyone loves</span><h2>On repeat.</h2></div><button type="button" className="mira-text-link" onClick={() => openListing('All')}>Shop all styles <ArrowIcon /></button></div>
          <div className="mira-product-grid">{['coastal-poplin-shirt', 'highline-straight-jean', 'the-sunday-dress', 'cloud-knit-pullover'].map((id) => products.find((product) => product.id === id)!).map((product) => <ProductCard key={product.id} product={product} />)}</div>
        </section>
        <section className="mira-values-band"><span>More to love, less to think about.</span><p>Clothes for actual days, not just perfect ones.</p><button type="button" onClick={() => openListing('All')}>Meet the collection <ArrowIcon /></button></section>
      </>}

      {view === 'listing' && <section className="mira-listing-page">
        <div className="mira-breadcrumb"><button type="button" onClick={goHome}>Home</button><span>/</span><span>{query ? `Search: ${query}` : category === 'All' ? 'Shop all' : category}</span></div>
        <div className="mira-listing-intro"><span className="mira-eyebrow">The Mira collection</span><h1>{query ? <>Results for <em>“{query}”</em></> : category === 'All' ? <>Pieces to <em>live in.</em></> : <>{category} to <em>live in.</em></>}</h1><p>{query ? `${listedProducts.length} ${listedProducts.length === 1 ? 'piece' : 'pieces'} found` : 'Thoughtful shapes, good fabrics, and the details that make them yours.'}</p></div>
        <div className="mira-listing-toolbar"><div className="mira-category-pills"><button type="button" className={category === 'All' ? 'active' : ''} onClick={() => { setCategory('All'); track('category_selected', { category: 'All', query }) }}>All</button>{categories.map((item) => <button type="button" key={item} className={category === item ? 'active' : ''} onClick={() => { setCategory(item); track('category_selected', { category: item, query }) }}>{item}</button>)}</div><label className="mira-sort-label">Sort by <select value={sort} onChange={(event) => { const nextSort = event.target.value as SortOrder; setSort(nextSort); track('sort_changed', { sort: nextSort }) }}><option value="featured">Featured</option><option value="price-low">Price: low to high</option><option value="price-high">Price: high to low</option></select></label></div>
        {listedProducts.length ? <div className="mira-product-grid mira-listing-grid">{listedProducts.map((product) => <ProductCard key={product.id} product={product} />)}</div> : <div className="mira-empty-results"><span>✳</span><h2>No pieces found</h2><p>Try a different search or browse the full collection.</p><button type="button" className="mira-primary-button" onClick={() => openListing('All')}>Shop all <ArrowIcon /></button></div>}
      </section>}

      {view === 'product' && selectedProduct && <section className="mira-detail-page">
        <div className="mira-breadcrumb"><button type="button" onClick={goHome}>Home</button><span>/</span><button type="button" onClick={() => openListing(selectedProduct.category)}>{selectedProduct.category}</button><span>/</span><span>{selectedProduct.name}</span></div>
        <div className="mira-detail-layout"><div className="mira-detail-images"><div className="mira-detail-main-image"><img src={selectedProduct.image} alt={selectedProduct.name} style={{ objectPosition: selectedProduct.imagePosition }} />{selectedProduct.badge && <span className="mira-product-badge">{selectedProduct.badge}</span>}</div><div className="mira-detail-image-caption">Made for the moments in between.</div></div><div className="mira-detail-info"><span className="mira-eyebrow">{selectedProduct.category} / Everyday favorites</span><h1>{selectedProduct.name}</h1><div className="mira-detail-price">{money(selectedProduct.price)}</div><p className="mira-detail-description">{selectedProduct.description}</p><div className="mira-detail-rule" /><div className="mira-color-row"><span>Color</span><strong>{selectedProduct.color}</strong></div><div className="mira-color-swatch" style={{ background: colorSwatch(selectedProduct.color) }} aria-label={selectedProduct.color} /><div className="mira-size-heading" id="mira-size-choices"><span>Size</span><span>Select your size</span></div><div className="mira-size-grid">{selectedProduct.sizes.map((size) => <button type="button" key={size} className={selectedSize === size ? 'selected' : ''} onClick={() => chooseSize(size)} aria-pressed={selectedSize === size}>{size}</button>)}</div><div className="mira-add-row"><div className="mira-quantity-control"><button type="button" onClick={() => setQuantity((value) => Math.max(1, value - 1))} aria-label="Decrease quantity">−</button><span>{quantity}</span><button type="button" onClick={() => setQuantity((value) => value + 1)} aria-label="Increase quantity">+</button></div><button type="button" className="mira-primary-button mira-add-button" onClick={addToBag}>Add to bag <ArrowIcon /></button></div><p className="mira-shipping-note">Complimentary shipping on orders over $100. Easy returns within 30 days.</p><div className="mira-detail-accordion"><details><summary>Details & care <span>+</span></summary><p>{selectedProduct.material}. {selectedProduct.fit}. Machine wash cold with like colors; lay flat to dry.</p></details><details><summary>Shipping & returns <span>+</span></summary><p>Standard delivery in 3–5 business days. Returns are accepted within 30 days for unworn items.</p></details></div></div></div>
        <div className="mira-related"><div className="mira-section-heading"><div><span className="mira-eyebrow">Good together</span><h2>You might also like.</h2></div></div><div className="mira-product-grid">{products.filter((product) => product.category === selectedProduct.category && product.id !== selectedProduct.id).slice(0, 3).map((product) => <ProductCard key={product.id} product={product} />)}</div></div>
      </section>}

      {view === 'bag' && <section className="mira-bag-page"><div className="mira-breadcrumb"><button type="button" onClick={goHome}>Home</button><span>/</span><span>Bag</span></div><div className="mira-section-heading"><div><span className="mira-eyebrow">Your good choices</span><h1>Your bag <em>({cartCount})</em></h1></div></div>{cart.length ? <div className="mira-bag-layout"><div className="mira-bag-items">{cart.map((item) => { const product = products.find((candidate) => candidate.id === item.productId); if (!product) return null; return <div className="mira-bag-item" key={`${item.productId}-${item.size}`}><button type="button" className="mira-bag-item-image" onClick={() => openProduct(product)}><img src={product.image} alt={product.name} /></button><div className="mira-bag-item-copy"><span className="mira-eyebrow">{product.category}</span><button type="button" className="mira-bag-product-name" onClick={() => openProduct(product)}>{product.name}</button><p>{product.color} · Size {item.size}</p><div className="mira-quantity-control"><button type="button" onClick={() => updateCart(item.productId, item.size, item.quantity - 1)} aria-label={`Remove one ${product.name}`}>−</button><span>{item.quantity}</span><button type="button" onClick={() => updateCart(item.productId, item.size, item.quantity + 1)} aria-label={`Add one ${product.name}`}>+</button></div></div><div className="mira-bag-item-end"><strong>{money(product.price * item.quantity)}</strong><button type="button" onClick={() => updateCart(item.productId, item.size, 0)}>Remove</button></div></div> })}</div><div className="mira-order-summary"><h2>Order summary</h2><div><span>Subtotal</span><strong>{money(subtotal)}</strong></div><div><span>Shipping</span><strong>{shipping ? money(shipping) : 'Complimentary'}</strong></div><div className="mira-summary-total"><span>Total</span><strong>{money(subtotal + shipping)}</strong></div><p>{shipping ? `You're ${money(100 - subtotal)} away from complimentary shipping.` : 'Your order qualifies for complimentary shipping.'}</p><button type="button" className="mira-primary-button" onClick={() => { setView('checkout'); track('checkout_started', { itemCount: cartCount, subtotal }); scrollTop() }}>Continue to checkout <ArrowIcon /></button><button type="button" className="mira-continue-link" onClick={() => openListing('All')}>Continue shopping</button></div></div> : <div className="mira-empty-results"><span>✳</span><h2>Something good goes here.</h2><p>Your bag is empty. Let's find a piece you'll love.</p><button type="button" className="mira-primary-button" onClick={() => openListing('All')}>Explore the collection <ArrowIcon /></button></div>}</section>}

      {view === 'checkout' && <section className="mira-checkout-page"><div className="mira-breadcrumb"><button type="button" onClick={() => setView('bag')}>Bag</button><span>/</span><span>Checkout</span></div><div className="mira-section-heading"><div><span className="mira-eyebrow">Almost yours</span><h1>Checkout<span className="mira-heading-period">.</span></h1></div></div><div className="mira-checkout-layout"><form className="mira-checkout-form" onSubmit={(event) => { event.preventDefault(); track('checkout_completed', { itemCount: cartCount, subtotal }); setCart([]); setView('complete'); scrollTop() }}><p className="mira-demo-notice">This is a demo store. No payment details are collected and no order is placed.</p><h2>Contact</h2><label>Email address<input type="email" required value={checkoutEmail} onChange={(event) => setCheckoutEmail(event.target.value)} placeholder="you@example.com" /></label><h2>Delivery</h2><div className="mira-form-two"><label>First name<input required autoComplete="given-name" placeholder="First name" /></label><label>Last name<input required autoComplete="family-name" placeholder="Last name" /></label></div><label>Address<input required autoComplete="street-address" placeholder="Street address" /></label><div className="mira-form-two"><label>City<input required autoComplete="address-level2" placeholder="City" /></label><label>ZIP code<input required autoComplete="postal-code" placeholder="ZIP code" /></label></div><button type="submit" className="mira-primary-button">Place demo order <ArrowIcon /></button></form><div className="mira-order-summary"><h2>Your order</h2>{cart.map((item) => { const product = products.find((candidate) => candidate.id === item.productId); if (!product) return null; return <div className="mira-checkout-item" key={`${item.productId}-${item.size}`}><img src={product.image} alt="" /><div><strong>{product.name}</strong><span>{product.color} · {item.size} · Qty {item.quantity}</span></div><strong>{money(product.price * item.quantity)}</strong></div> })}<div><span>Subtotal</span><strong>{money(subtotal)}</strong></div><div><span>Shipping</span><strong>{shipping ? money(shipping) : 'Complimentary'}</strong></div><div className="mira-summary-total"><span>Total</span><strong>{money(subtotal + shipping)}</strong></div></div></div></section>}

      {view === 'complete' && <section className="mira-complete-page"><span className="mira-complete-mark">✳</span><span className="mira-eyebrow">A lovely choice</span><h1>All done, <em>beautifully.</em></h1><p>You made it through the demo checkout. No order was placed and no payment was taken.</p><button type="button" className="mira-primary-button" onClick={() => openListing('All')}>Keep exploring <ArrowIcon /></button></section>}
    </main>

    <footer className="mira-footer"><div><button type="button" className="mira-wordmark" onClick={goHome}>mira<span>.</span></button><p>Better everyday clothes for actual everyday life.</p></div><div><span>Explore</span>{categories.map((item) => <button type="button" key={item} onClick={() => openListing(item)}>{item}</button>)}</div><div><span>Good to know</span><p>Complimentary shipping on orders $100+</p><p>Easy returns within 30 days</p></div><div className="mira-footer-bottom"><span>© 2026 Mira Studio. A sample storefront for research. Photos via Unsplash.</span><span>Wear what feels like you. ✳</span></div></footer>
  </div>
}

function colorSwatch(color: string) {
  const swatches: Record<string, string> = {
    'Sky Blue': '#8eafc6', 'Warm Ivory': '#e9e1d5', 'Soft Rose': '#d3a3a6', 'Midnight Blue': '#23384a',
    'Classic Indigo': '#3d536e', 'Washed Blue': '#91a8bd', Ecru: '#dfd8c8', 'Washed Black': '#464441',
    'Cornflower Blue': '#7396c2', Wildflower: '#c4898c', 'Ink Black': '#252528', 'Golden Ochre': '#c99c53',
    Sand: '#bdac91', Charcoal: '#535353', 'Light Blue': '#91b4c5', Olive: '#717c5e', Oat: '#d8cdb9',
    'Sea Blue': '#507f8d', Mulberry: '#704258', 'Forest Green': '#3d654e', Clay: '#b77f63', 'Dark Indigo': '#28384a', 'Deep Red': '#9b303b', 'Rust Red': '#a95139',
  }
  return swatches[color] ?? '#c5bdaf'
}
