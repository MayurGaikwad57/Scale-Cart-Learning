// Products have no photos yet, so each one gets generated "art": a soft gradient (hue per category,
// nudged by the SKU so neighbours differ) with an emoji. Deterministic: the same SKU always looks the same.
const CATEGORY_HUE: Record<string, number> = { Electronics: 232, Books: 28, Home: 160, Fashion: 332 };
const CATEGORY_EMOJI: Record<string, string> = { Electronics: '🎧', Books: '📚', Home: '🏠', Fashion: '👕' };
const SKU_EMOJI: Record<string, string> = {
  'ELEC-001': '🎧', 'ELEC-002': '⌨️', 'ELEC-003': '🔌', 'ELEC-004': '🖥️', 'ELEC-005': '⌚',
  'BOOK-001': '📘', 'BOOK-002': '📗', 'BOOK-003': '📙',
  'HOME-001': '☕', 'HOME-002': '💡', 'HOME-003': '🛏️',
  'FASH-001': '👕', 'FASH-002': '👟', 'FASH-003': '🎒',
};

const hash = (s: string): number => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export function productArt(sku: string, category: string): { background: string; emoji: string } {
  const hue = (CATEGORY_HUE[category] ?? 200) + (hash(sku) % 40) - 20;
  return {
    background: `linear-gradient(135deg, hsl(${hue} 92% 95%) 0%, hsl(${hue + 26} 88% 85%) 100%)`,
    emoji: SKU_EMOJI[sku] ?? CATEGORY_EMOJI[category] ?? '📦',
  };
}

export const categoryEmoji = (category: string): string => CATEGORY_EMOJI[category] ?? '📦';
