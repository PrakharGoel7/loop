import type { Dispatch, SetStateAction } from 'react'
import { products } from './catalog'
import type { Category, Product, Size } from './catalog'
import { ProductCard } from './ProductCard'
import { ArrowIcon, colorSwatch, money } from './presentation'

type ProductDetailProps = {
  selectedProduct: Product
  selectedSize: Size | null
  quantity: number
  goHome: () => void
  openListing: (category: Category) => void
  openProduct: (product: Product) => void
  chooseSize: (size: Size) => void
  setQuantity: Dispatch<SetStateAction<number>>
  addToBag: () => void
}

export function ProductDetail({ selectedProduct, selectedSize, quantity, goHome, openListing, openProduct, chooseSize, setQuantity, addToBag }: ProductDetailProps) {
  return <section className="mira-detail-page">
        <div className="mira-breadcrumb">
        <button type="button" onClick={goHome}>Home</button>
        <span>/</span>
        <button type="button" onClick={() => openListing(selectedProduct.category)}>{selectedProduct.category}</button>
        <span>/</span>
        <span>{selectedProduct.name}</span>
        </div>
        <div className="mira-detail-layout">
        <div className="mira-detail-images">
        <div className="mira-detail-main-image">
        <img src={selectedProduct.image} alt={selectedProduct.name} style={{ objectPosition: selectedProduct.imagePosition }} />{selectedProduct.badge && <span className="mira-product-badge">{selectedProduct.badge}</span>}</div>
        <div className="mira-detail-image-caption">Made for the moments in between.</div>
        </div>
        <div className="mira-detail-info">
        <span className="mira-eyebrow">{selectedProduct.category} / Everyday favorites</span>
        <h1>{selectedProduct.name}</h1>
        <div className="mira-detail-price">{money(selectedProduct.price)}</div>
        <p className="mira-detail-description">{selectedProduct.description}</p>
        <div className="mira-detail-rule" />
        <div className="mira-color-row">
        <span>Color</span>
        <strong>{selectedProduct.color}</strong>
        </div>
        <div className="mira-color-swatch" style={{ background: colorSwatch(selectedProduct.color) }} aria-label={selectedProduct.color} />
        <div className="mira-size-heading" id="mira-size-choices">
        <span>Size</span>
        <span>Select your size</span>
        </div>
        <div className="mira-size-grid">
        {selectedProduct.sizes.map((size) => <button type="button" key={size} className={selectedSize === size ? 'selected' : ''} onClick={() => chooseSize(size)} aria-pressed={selectedSize === size}>{size}</button>)}</div>
        <div className="mira-add-row">
        <div className="mira-quantity-control">
        <button type="button" onClick={() => setQuantity((value) => Math.max(1, value - 1))} aria-label="Decrease quantity">−</button>
        <span>{quantity}</span>
        <button type="button" onClick={() => setQuantity((value) => value + 1)} aria-label="Increase quantity">+</button>
        </div>
        <button type="button" className="mira-primary-button mira-add-button" onClick={addToBag}>Add to bag <ArrowIcon />
        </button>
        </div>
        <p className="mira-shipping-note">Complimentary shipping on orders over $100. Easy returns within 30 days.</p>
        <div className="mira-detail-accordion">
        <details>
        <summary>Details & care <span>+</span>
        </summary>
        <p>{selectedProduct.material}. {selectedProduct.fit}. Machine wash cold with like colors; lay flat to dry.</p>
        </details>
        <details>
        <summary>Shipping & returns <span>+</span>
        </summary>
        <p>Standard delivery in 3–5 business days. Returns are accepted within 30 days for unworn items.</p>
        </details>
        </div>
        </div>
        </div>
        <div className="mira-related">
        <div className="mira-section-heading">
        <div>
        <span className="mira-eyebrow">Good together</span>
        <h2>You might also like.</h2>
        </div>
        </div>
        <div className="mira-product-grid">
        {products.filter((product) => product.category === selectedProduct.category && product.id !== selectedProduct.id).slice(0, 3).map((product) => <ProductCard key={product.id} product={product} onOpen={openProduct} />)}</div>
        </div>
      </section>
}
