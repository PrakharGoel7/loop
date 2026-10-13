export const money = (amount: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(amount)


export function ArrowIcon({ direction = 'right' }: { direction?: 'right' | 'left' }) {
  return <svg width="19" height="19" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={direction === 'left' ? { transform: 'rotate(180deg)' } : undefined}><path d="M2.5 10h14M11 4.5l5.5 5.5-5.5 5.5" /></svg>
}


export function colorSwatch(color: string) {
  const swatches: Record<string, string> = {
    'Sky Blue': '#8eafc6', 'Warm Ivory': '#e9e1d5', 'Soft Rose': '#d3a3a6', 'Midnight Blue': '#23384a',
    'Classic Indigo': '#3d536e', 'Washed Blue': '#91a8bd', Ecru: '#dfd8c8', 'Washed Black': '#464441',
    'Cornflower Blue': '#7396c2', Wildflower: '#c4898c', 'Ink Black': '#252528', 'Golden Ochre': '#c99c53',
    Sand: '#bdac91', Charcoal: '#535353', 'Light Blue': '#91b4c5', Olive: '#717c5e', Oat: '#d8cdb9',
    'Sea Blue': '#507f8d', Mulberry: '#704258', 'Forest Green': '#3d654e', Clay: '#b77f63', 'Dark Indigo': '#28384a', 'Deep Red': '#9b303b', 'Rust Red': '#a95139',
  }
  return swatches[color] ?? '#c5bdaf'
}
