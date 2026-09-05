CREATE TABLE "addon_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"min_select" integer DEFAULT 0 NOT NULL,
	"max_select" integer DEFAULT 10 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "addons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price" integer DEFAULT 0 NOT NULL,
	"food_type" text DEFAULT 'VEG' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"user_id" uuid,
	"user_name" text,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"bill_number" text NOT NULL,
	"provisional_number" text,
	"status" text DEFAULT 'UNPAID' NOT NULL,
	"computed" jsonb NOT NULL,
	"subtotal" integer NOT NULL,
	"discount_total" integer NOT NULL,
	"service_charge" integer NOT NULL,
	"tax_total" integer NOT NULL,
	"cgst_total" integer NOT NULL,
	"sgst_total" integer NOT NULL,
	"round_off" integer NOT NULL,
	"grand_total" integer NOT NULL,
	"paid_total" integer DEFAULT 0 NOT NULL,
	"print_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	"void_reason" text
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "counters" (
	"outlet_id" uuid NOT NULL,
	"key" text NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "counters_outlet_id_key_pk" PRIMARY KEY("outlet_id","key")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"name" text,
	"email" text,
	"address" text,
	"visits" integer DEFAULT 0 NOT NULL,
	"total_spend" integer DEFAULT 0 NOT NULL,
	"loyalty_points" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_visit_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "item_addon_groups" (
	"item_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	CONSTRAINT "item_addon_groups_item_id_group_id_pk" PRIMARY KEY("item_id","group_id")
);
--> statement-breakpoint
CREATE TABLE "kots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"kot_number" text NOT NULL,
	"station" text DEFAULT 'KITCHEN' NOT NULL,
	"kind" text DEFAULT 'NEW' NOT NULL,
	"status" text DEFAULT 'NEW' NOT NULL,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"print_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"bumped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "menu_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"station" text DEFAULT 'KITCHEN' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"availability" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "menu_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	"name" text NOT NULL,
	"short_code" text,
	"description" text,
	"food_type" text DEFAULT 'VEG' NOT NULL,
	"price" integer NOT NULL,
	"online_price" integer,
	"tax_slab_id" uuid,
	"packaging_charge" integer DEFAULT 0 NOT NULL,
	"station" text,
	"available" boolean DEFAULT true NOT NULL,
	"stock_out" boolean DEFAULT false NOT NULL,
	"image_url" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"item_id" uuid,
	"name" text NOT NULL,
	"variation_id" uuid,
	"variation_name" text,
	"unit_price" integer NOT NULL,
	"addons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"qty" integer NOT NULL,
	"note" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"tax_rate_bps" integer DEFAULT 0 NOT NULL,
	"tax_inclusive" boolean DEFAULT false NOT NULL,
	"packaging_charge" integer DEFAULT 0 NOT NULL,
	"station" text DEFAULT 'KITCHEN' NOT NULL,
	"discount" jsonb,
	"kot_id" uuid,
	"void_reason" text,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"outlet_id" uuid NOT NULL,
	"order_number" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"table_id" uuid,
	"table_name" text,
	"customer_id" uuid,
	"customer_name" text,
	"customer_phone" text,
	"delivery_address" text,
	"covers" integer DEFAULT 1 NOT NULL,
	"notes" text,
	"discount" jsonb,
	"service_charge_bps" integer,
	"delivery_charge" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"device_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"billed_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"merged_into_order_id" uuid
);
--> statement-breakpoint
CREATE TABLE "outlets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand_id" uuid,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"address_lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"phone" text,
	"gstin" text,
	"fssai" text,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"business_hours" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outlets_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"outlet_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"amount" integer NOT NULL,
	"tendered" integer,
	"reference" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "printers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"station" text NOT NULL,
	"kind" text DEFAULT 'NETWORK' NOT NULL,
	"host" text,
	"port" integer DEFAULT 9100 NOT NULL,
	"width" integer DEFAULT 42 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_ops" (
	"id" uuid PRIMARY KEY NOT NULL,
	"outlet_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"response" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"area_id" uuid NOT NULL,
	"name" text NOT NULL,
	"capacity" integer DEFAULT 4 NOT NULL,
	"status" text DEFAULT 'FREE' NOT NULL,
	"current_order_id" uuid,
	"pos_x" integer DEFAULT 0 NOT NULL,
	"pos_y" integer DEFAULT 0 NOT NULL,
	"shape" text DEFAULT 'square' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_slabs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"rate_bps" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outlet_id" uuid NOT NULL,
	"name" text NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"pin_hash" text,
	"role" text NOT NULL,
	"permission_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "variations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"name" text NOT NULL,
	"price" integer NOT NULL,
	"online_price" integer,
	"is_default" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "addon_groups" ADD CONSTRAINT "addon_groups_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addons" ADD CONSTRAINT "addons_group_id_addon_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."addon_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "areas" ADD CONSTRAINT "areas_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_addon_groups" ADD CONSTRAINT "item_addon_groups_item_id_menu_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_addon_groups" ADD CONSTRAINT "item_addon_groups_group_id_addon_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."addon_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kots" ADD CONSTRAINT "kots_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kots" ADD CONSTRAINT "kots_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kots" ADD CONSTRAINT "kots_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_categories" ADD CONSTRAINT "menu_categories_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_category_id_menu_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."menu_categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_tax_slab_id_tax_slabs_id_fk" FOREIGN KEY ("tax_slab_id") REFERENCES "public"."tax_slabs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_item_id_menu_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."menu_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outlets" ADD CONSTRAINT "outlets_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "printers" ADD CONSTRAINT "printers_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_area_id_areas_id_fk" FOREIGN KEY ("area_id") REFERENCES "public"."areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_slabs" ADD CONSTRAINT "tax_slabs_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_outlet_id_outlets_id_fk" FOREIGN KEY ("outlet_id") REFERENCES "public"."outlets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variations" ADD CONSTRAINT "variations_item_id_menu_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."menu_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_outlet_created_idx" ON "audit_logs" USING btree ("outlet_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bills_outlet_number_idx" ON "bills" USING btree ("outlet_id","bill_number");--> statement-breakpoint
CREATE INDEX "bills_order_idx" ON "bills" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_outlet_phone_idx" ON "customers" USING btree ("outlet_id","phone");--> statement-breakpoint
CREATE INDEX "kots_order_idx" ON "kots" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "kots_outlet_status_idx" ON "kots" USING btree ("outlet_id","status");--> statement-breakpoint
CREATE INDEX "menu_items_outlet_idx" ON "menu_items" USING btree ("outlet_id");--> statement-breakpoint
CREATE INDEX "menu_items_cat_idx" ON "menu_items" USING btree ("category_id");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_outlet_status_idx" ON "orders" USING btree ("outlet_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_outlet_number_idx" ON "orders" USING btree ("outlet_id","order_number");--> statement-breakpoint
CREATE INDEX "orders_created_idx" ON "orders" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "payments_bill_idx" ON "payments" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "payments_created_idx" ON "payments" USING btree ("outlet_id","created_at");--> statement-breakpoint
CREATE INDEX "sync_ops_device_idx" ON "sync_ops" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "tables_outlet_idx" ON "tables" USING btree ("outlet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_idx" ON "users" USING btree ("username");