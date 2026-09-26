CREATE TABLE "user_custom_providers" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid() NOT NULL,
	"kilo_user_id" text,
	"organization_id" uuid,
	"provider_id" text NOT NULL,
	"display_name" text NOT NULL,
	"base_url" text NOT NULL,
	"provider_api" text DEFAULT 'openai-compatible' NOT NULL,
	"api_key_encrypted" jsonb NOT NULL,
	"models" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "UQ_user_custom_providers_user_provider" UNIQUE("kilo_user_id","provider_id"),
	CONSTRAINT "UQ_user_custom_providers_org_provider" UNIQUE("organization_id","provider_id"),
	CONSTRAINT "user_custom_providers_owner_check" CHECK ((
        ("user_custom_providers"."kilo_user_id" IS NOT NULL AND "user_custom_providers"."organization_id" IS NULL) OR
        ("user_custom_providers"."kilo_user_id" IS NULL AND "user_custom_providers"."organization_id" IS NOT NULL)
      ))
);
--> statement-breakpoint
ALTER TABLE "user_custom_providers" ADD CONSTRAINT "user_custom_providers_kilo_user_id_kilocode_users_id_fk" FOREIGN KEY ("kilo_user_id") REFERENCES "public"."kilocode_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_custom_providers" ADD CONSTRAINT "user_custom_providers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "IDX_user_custom_providers_user_id" ON "user_custom_providers" USING btree ("kilo_user_id");--> statement-breakpoint
CREATE INDEX "IDX_user_custom_providers_org_id" ON "user_custom_providers" USING btree ("organization_id");