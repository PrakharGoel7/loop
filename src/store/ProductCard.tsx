import type { Product } from './catalog'
import { ArrowIcon, money } from './presentation'

export function ProductCard({ product, onOpen }: { product: Product; onOpen: (product: Product) => void }) {
  return (
    <button type="button" className="mira-product-card" onClick={() => onOpen(product)} aria-label={`View ${product.name}, ${money(product.price)}`}>
      <span className="mira-product-image-wrap">
        <img src={product.image} alt={product.name} style={{ objectPosition: product.imagePosition }} loading="lazy" />
        {product.badge && <span className="mira-product-badge">{product.badge}</span>}
        <span className="mira-card-quick">Explore <ArrowIcon /></span>
      </span>
      <span className="mira-product-meta"><span>{product.category} <span className="mira-meta-dot">·</span> {product.color}</span><span>{money(product.price)}</span></span>
      <span className="mira-product-name">{product.name}</span>
    </button>
  )
}
