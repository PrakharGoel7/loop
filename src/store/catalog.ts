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
