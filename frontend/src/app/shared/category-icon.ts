// Products have no images yet, so each category gets an emoji tile instead.
const icons: Record<string, string> = {
  Electronics: '🎧',
  Books: '📚',
  Home: '🏠',
  Fashion: '👕',
};

export const categoryIcon = (category: string): string => icons[category] ?? '📦';
