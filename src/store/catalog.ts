export const categories = ['Tops', 'Jeans', 'Dresses', 'Jackets', 'Sweaters'] as const

export type Category = (typeof categories)[number]
export type Size = 'XS' | 'S' | 'M' | 'L' | 'XL'

export interface Product {
  id: string
  name: string
  category: Category
  color: string
  price: number
  image: string
  imagePosition?: string
  description: string
  material: string
  fit: string
  sizes: Size[]
  measurements: Partial<Record<Size, string>>
  badge?: string
  keywords?: string[]
}

const photoAssets = import.meta.glob<string>('./assets/*.jpg', { eager: true, query: '?url', import: 'default' })
const photo = (id: string) => photoAssets[`./assets/${id}.jpg`] ?? ''

const topMeasurements: Record<Size, string> = {
  XS: 'Bust 78–82 cm · Waist 60–64 cm',
  S: 'Bust 83–87 cm · Waist 65–69 cm',
  M: 'Bust 88–93 cm · Waist 70–75 cm',
  L: 'Bust 94–100 cm · Waist 76–82 cm',
  XL: 'Bust 101–108 cm · Waist 83–90 cm',
}

const denimMeasurements: Record<Size, string> = {
  XS: 'Waist 60–64 cm · Hip 84–88 cm',
  S: 'Waist 65–69 cm · Hip 89–93 cm',
  M: 'Waist 70–75 cm · Hip 94–99 cm',
  L: 'Waist 76–82 cm · Hip 100–106 cm',
  XL: 'Waist 83–90 cm · Hip 107–114 cm',
}

export const products: Product[] = [
  {
    id: 'coastal-poplin-shirt', name: 'Coastal Poplin Shirt', category: 'Tops', color: 'Sky Blue', price: 68,
    image: photo('1748785825960-79336740e95e'), imagePosition: 'center 42%',
    description: 'An easy everyday shirt with a relaxed shape, crisp collar and softly curved hem.',
    material: '100% cotton poplin', fit: 'Relaxed fit', sizes: ['XS', 'S', 'M', 'L', 'XL'],
    measurements: topMeasurements, badge: 'Bestseller', keywords: ['blue', 'shirt', 'blouse', 'top'],
  },
  {
    id: 'weekend-linen-tank', name: 'Weekend Cotton Tank', category: 'Tops', color: 'Warm Ivory', price: 48,
    image: photo('1668542251587-23fad7d03058'),
    description: 'A simple warm-weather layer with a soft ribbed texture and easy shape.',
    material: 'Organic cotton rib', fit: 'Easy fit', sizes: ['XS', 'S', 'M', 'L'],
    measurements: topMeasurements, keywords: ['white', 'cream', 'tank', 'top'],
  },
  {
    id: 'everyday-rib-tee', name: 'Everyday Graphic Tee', category: 'Tops', color: 'Washed Black', price: 42,
    image: photo('1554568218-0f1715e72254'),
    description: 'The dependable tee you reach for first, with a vintage wash and a soft hand feel.',
    material: 'Organic cotton jersey', fit: 'Easy fit', sizes: ['XS', 'S', 'M', 'L', 'XL'],
    measurements: topMeasurements, keywords: ['black', 'tee', 'tshirt', 'top'],
  },
  {
    id: 'harbor-stripe-breton', name: 'Harbor Stripe Breton', category: 'Tops', color: 'Cream / Navy', price: 64,
    image: photo('harbor-stripe-breton'),
    description: 'A soft, long-sleeve stripe with a boat neckline and an easy shape for everyday wear.',
    material: '100% cotton jersey', fit: 'Relaxed fit', sizes: ['XS', 'S', 'M', 'L', 'XL'],
    measurements: topMeasurements, keywords: ['striped', 'stripe', 'navy', 'cream', 'long sleeve', 'breton', 'top'],
  },
  {
    id: 'meadow-linen-blouse', name: 'Meadow Linen Blouse', category: 'Tops', color: 'Sage Green', price: 76,
    image: photo('meadow-linen-blouse'),
    description: 'A breezy button-front blouse with gently gathered sleeves and a naturally textured finish.',
    material: '100% linen', fit: 'Easy fit', sizes: ['XS', 'S', 'M', 'L', 'XL'],
    measurements: topMeasurements, keywords: ['sage', 'green', 'linen', 'blouse', 'button', 'short sleeve', 'top'],
  },
  {
    id: 'cobalt-wrap-top', name: 'Cobalt Wrap Top', category: 'Tops', color: 'Cobalt Blue', price: 72,
    image: photo('cobalt-wrap-top'),
    description: 'A softly draped wrap top with a side tie that lets you adjust the waist.',
    material: 'Cotton and modal jersey', fit: 'Adjustable wrap', sizes: ['XS', 'S', 'M', 'L', 'XL'],
    measurements: topMeasurements, badge: 'New', keywords: ['blue', 'cobalt', 'wrap', 'long sleeve', 'top'],
  },
  {
    id: 'terra-satin-cami', name: 'Terra Satin Cami', category: 'Tops', color: 'Terracotta', price: 58,
    image: photo('terra-satin-cami'),
    description: 'A fluid camisole with a soft cowl neckline, made for layering or wearing on its own.',
    material: 'Recycled polyester satin', fit: 'Skims the body', sizes: ['XS', 'S', 'M', 'L'],
    measurements: topMeasurements, keywords: ['terracotta', 'rust', 'orange', 'satin', 'cami', 'camisole', 'top'],
  },
  {
    id: 'ivory-eyelet-blouse', name: 'Ivory Eyelet Blouse', category: 'Tops', color: 'Soft Ivory', price: 84,
    image: photo('ivory-eyelet-blouse'),
    description: 'A light cotton blouse with delicate eyelet details and gently rounded puff sleeves.',
    material: '100% cotton eyelet', fit: 'Relaxed fit', sizes: ['XS', 'S', 'M', 'L', 'XL'],
    measurements: topMeasurements, keywords: ['ivory', 'white', 'cream', 'eyelet', 'embroidered', 'puff sleeve', 'blouse', 'top'],
  },
  {
    id: 'noir-square-neck-tank', name: 'Noir Square-Neck Tank', category: 'Tops', color: 'Black', price: 44,
    image: photo('noir-square-neck-tank'),
    description: 'A substantial ribbed tank with wide straps and a clean square neckline.',
    material: 'Organic cotton and elastane rib', fit: 'Close fit', sizes: ['XS', 'S', 'M', 'L', 'XL'],
    measurements: topMeasurements, keywords: ['black', 'square neck', 'ribbed', 'sleeveless', 'tank', 'top'],
  },
  {
    id: 'plum-mock-neck-shell', name: 'Plum Mock-Neck Shell', category: 'Tops', color: 'Deep Plum', price: 62,
    image: photo('plum-mock-neck-shell'),
    description: 'A fine-knit sleeveless shell that sits neatly under a jacket or stands on its own.',
    material: 'Cotton and TENCEL™ modal knit', fit: 'Fitted silhouette', sizes: ['XS', 'S', 'M', 'L', 'XL'],
    measurements: topMeasurements, keywords: ['plum', 'purple', 'burgundy', 'mock neck', 'sleeveless', 'knit', 'shell', 'top'],
  },
  {
    id: 'sunny-camp-shirt', name: 'Sunny Camp Shirt', category: 'Tops', color: 'Butter Yellow', price: 66,
    image: photo('sunny-camp-shirt'),
    description: 'An easy short-sleeve button-up with an open camp collar and a breezy shape.',
    material: '100% cotton poplin', fit: 'Boxy relaxed', sizes: ['XS', 'S', 'M', 'L', 'XL'],
    measurements: topMeasurements, keywords: ['yellow', 'butter', 'camp collar', 'button up', 'short sleeve', 'shirt', 'top'],
  },
  {
    id: 'lagoon-pleat-top', name: 'Lagoon Pleat Top', category: 'Tops', color: 'Deep Teal', price: 74,
    image: photo('lagoon-pleat-top'),
    description: 'Fine vertical pleats give this lightweight shell movement without losing its shape.',
    material: 'Recycled polyester georgette', fit: 'Flowing fit', sizes: ['XS', 'S', 'M', 'L'],
    measurements: topMeasurements, keywords: ['teal', 'blue green', 'pleated', 'sleeveless', 'shell', 'blouse', 'top'],
  },
  {
    id: 'rose-knit-polo', name: 'Rose Knit Polo', category: 'Tops', color: 'Dusty Rose', price: 68,
    image: photo('rose-knit-polo'),
    description: 'A soft short-sleeve polo with a small collar and a fine, breathable knit.',
    material: '100% organic cotton knit', fit: 'Classic fit', sizes: ['XS', 'S', 'M', 'L', 'XL'],
    measurements: topMeasurements, keywords: ['pink', 'rose', 'polo', 'collar', 'short sleeve', 'knit', 'top'],
  },
  {
    id: 'highline-straight-jean', name: 'Highline Straight Jean', category: 'Jeans', color: 'Classic Indigo', price: 98,
    image: photo('1598554747436-c9293d6a588f'),
    description: 'A straight-leg jean with the just-right rise and a little room to move.',
    material: '99% cotton, 1% elastane', fit: 'High-rise straight', sizes: ['XS', 'S', 'M', 'L', 'XL'],
    measurements: denimMeasurements, badge: 'Bestseller', keywords: ['blue', 'denim'],
  },
  {
    id: 'daybreak-wide-leg-jean', name: 'Daybreak Wide Leg Jean', category: 'Jeans', color: 'Washed Blue', price: 108,
    image: photo('1584370848010-d7fe6bc767ec'),
    description: 'A sweeping wide leg cut from substantial denim that softens with every wear.',
    material: '100% cotton denim', fit: 'Mid-rise wide leg', sizes: ['XS', 'S', 'M', 'L', 'XL'],
    measurements: denimMeasurements, keywords: ['blue', 'denim'],
  },
  {
    id: 'utility-denim', name: 'Utility Denim', category: 'Jeans', color: 'Washed Black', price: 112,
    image: photo('1555689502-c4b22d76c56f'),
    description: 'Workwear-inspired denim with a soft wash and practical pockets.',
    material: '100% cotton denim', fit: 'Relaxed straight', sizes: ['XS', 'S', 'M', 'L', 'XL'],
    measurements: denimMeasurements, keywords: ['black', 'denim'],
  },
  {
    id: 'the-sunday-dress', name: 'The Sunday Dress', category: 'Dresses', color: 'Cornflower Blue', price: 118,
    image: photo('1539008835657-9e8e9680c956'),
    description: 'A throw-on-and-go midi with a softly gathered waist and room to breathe.',
    material: 'Cotton voile', fit: 'Relaxed midi', sizes: ['XS', 'S', 'M', 'L', 'XL'],
    measurements: topMeasurements, badge: 'New', keywords: ['blue', 'midi'],
  },
  {
    id: 'garden-wrap-dress', name: 'Garden Wrap Dress', category: 'Dresses', color: 'Wildflower', price: 128,
    image: photo('1496747611176-843222e1e57c'),
    description: 'An adjustable wrap dress that moves beautifully from afternoon to evening.',
    material: 'Responsible viscose', fit: 'Adjustable wrap', sizes: ['XS', 'S', 'M', 'L', 'XL'],
    measurements: topMeasurements, keywords: ['floral', 'print', 'midi'],
  },
  {
    id: 'city-slip-dress', name: 'City Evening Dress', category: 'Dresses', color: 'Deep Red', price: 110,
    image: photo('1595777457583-95e059d581b8'),
    description: 'A fluid evening dress with beautiful movement and a gently defined waist.',
    material: 'Responsibly sourced viscose', fit: 'Skims the body', sizes: ['XS', 'S', 'M', 'L'],
    measurements: topMeasurements, keywords: ['red', 'evening'],
  },
  {
    id: 'everywhere-trench', name: 'Everywhere Bomber', category: 'Jackets', color: 'Clay', price: 184,
    image: photo('1591047139829-d91aecb6caea'),
    description: 'An everyday outer layer with an effortless shape and timeless details.',
    material: 'Cotton twill', fit: 'Relaxed fit', sizes: ['XS', 'S', 'M', 'L', 'XL'],
    measurements: topMeasurements, badge: 'Bestseller', keywords: ['brown', 'tan', 'coat'],
  },
  {
    id: 'cropped-denim-jacket', name: 'Leather Studio Jacket', category: 'Jackets', color: 'Ink Black', price: 124,
    image: photo('1551028719-00167b16eac5'),
    description: 'A softly structured black layer, cut a little shorter to work with everything.',
    material: 'Leather and recycled lining', fit: 'Boxy cropped', sizes: ['XS', 'S', 'M', 'L'],
    measurements: topMeasurements, keywords: ['black', 'leather'],
  },
  {
    id: 'quilted-weekender', name: 'Weekend Denim Jacket', category: 'Jackets', color: 'Dark Indigo', price: 146,
    image: photo('1544923246-77307dd654cb'),
    description: 'A lived-in denim layer with generous pockets for in-between days.',
    material: '100% cotton denim', fit: 'Oversized fit', sizes: ['XS', 'S', 'M', 'L', 'XL'],
    measurements: topMeasurements, keywords: ['blue', 'denim'],
  },
  {
    id: 'cloud-knit-pullover', name: 'Cloud Knit Pullover', category: 'Sweaters', color: 'Oat', price: 118,
    image: photo('1759229874914-c1ffdb3ebd0c'),
    description: 'A soft, lofty pullover that makes cold mornings feel a little easier.',
    material: 'Cotton and recycled alpaca', fit: 'Relaxed fit', sizes: ['XS', 'S', 'M', 'L', 'XL'],
    measurements: topMeasurements, badge: 'New', keywords: ['cream', 'beige', 'knit'],
  },
  {
    id: 'fisherman-cardigan', name: 'Blue Knit Pullover', category: 'Sweaters', color: 'Sea Blue', price: 132,
    image: photo('1627901840483-f38cd6a353bc'),
    description: 'A textured blue knit with a roomy, comfortable shape.',
    material: 'Organic cotton knit', fit: 'Relaxed fit', sizes: ['XS', 'S', 'M', 'L'],
    measurements: topMeasurements, keywords: ['blue', 'pullover', 'knit'],
  },
  {
    id: 'fine-gauge-crew', name: 'Fine Gauge Crew', category: 'Sweaters', color: 'Rust Red', price: 96,
    image: photo('1556537562-d1e655feefd5'),
    description: 'The lighter knit that sits just right under coats and over shirts.',
    material: 'Merino and organic cotton', fit: 'Classic fit', sizes: ['XS', 'S', 'M', 'L', 'XL'],
    measurements: topMeasurements, keywords: ['red', 'rust', 'knit'],
  },
]
