// Marketplace categories (sync with lib/models in the Flutter app).

export const MARKETPLACE_CATEGORIES = [
  "Bags", "Shoes", "Jewelry", "Dresses", "Electronics", "Groceries",
  "Fashion", "Home & Living", "Accessories", "Beauty", "Sports",
  "Toys & Kids", "Books", "Phones & Tablets", "Computers",
] as const;

export function isValidCategory(name: string): boolean {
  return (MARKETPLACE_CATEGORIES as readonly string[]).includes(name);
}
