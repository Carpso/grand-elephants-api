// Marketplace categories (bags-only marketplace; sync with sql/seed.sql).

export const MARKETPLACE_CATEGORIES = [
  "Tote Bags", "Backpacks", "Handbags", "Crossbody Bags", "Clutches",
  "Laptop Bags", "Duffel & Travel Bags", "Waist Bags", "Shopping Bags", "Baby Bags",
] as const;

export function isValidCategory(name: string): boolean {
  return (MARKETPLACE_CATEGORIES as readonly string[]).includes(name);
}
