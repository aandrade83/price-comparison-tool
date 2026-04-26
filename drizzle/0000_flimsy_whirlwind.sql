CREATE TABLE "competitor_prices" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer,
	"store" text NOT NULL,
	"zipcode" text,
	"matched_name" text,
	"price" numeric(10, 2),
	"size" text,
	"url" text,
	"source" text,
	"checked_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"brand" text,
	"size" text,
	"category" text,
	"upc" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "competitor_prices" ADD CONSTRAINT "competitor_prices_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;