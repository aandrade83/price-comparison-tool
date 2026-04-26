import { integer, numeric, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

export const products = pgTable('products', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  brand: text('brand'),
  size: text('size'),
  category: text('category'),
  upc: text('upc'),
  activeCost: numeric('active_cost', { precision: 10, scale: 2 }),
  createdAt: timestamp('created_at').defaultNow(),
});

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;

export const competitorPrices = pgTable('competitor_prices', {
  id:           serial('id').primaryKey(),
  productId:    integer('product_id').references(() => products.id),
  store:        text('store').notNull(),
  zipcode:      text('zipcode'),
  matchedName:  text('matched_name'),
  price:        numeric('price', { precision: 10, scale: 2 }),
  size:         text('size'),
  url:          text('url'),
  source:       text('source'),
  matchQuality: text('match_quality'),  // 'HIGH' | 'MEDIUM' | 'LOW'
  checkedAt:    timestamp('checked_at').defaultNow(),
});

export type CompetitorPrice = typeof competitorPrices.$inferSelect;
export type NewCompetitorPrice = typeof competitorPrices.$inferInsert;
