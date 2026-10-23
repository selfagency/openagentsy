CREATE TABLE `budgets` (
	`bean` text PRIMARY KEY NOT NULL,
	`token_limit` integer NOT NULL,
	`stop_at` integer NOT NULL,
	`tokens_used` integer DEFAULT 0 NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `leases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bean` text NOT NULL,
	`agent` text NOT NULL,
	`glob` text NOT NULL,
	`granted_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `leases_agent_glob` ON `leases` (`agent`,`glob`);--> statement-breakpoint
CREATE TABLE `record_reads` (
	`record_id` integer NOT NULL,
	`agent` text NOT NULL,
	`read_at` text NOT NULL,
	PRIMARY KEY(`record_id`, `agent`)
);
--> statement-breakpoint
CREATE TABLE `records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bean` text NOT NULL,
	`kind` text NOT NULL,
	`from_agent` text NOT NULL,
	`to_agent` text,
	`action` text NOT NULL,
	`state` text NOT NULL,
	`artifact` text,
	`contract` text,
	`needs` text,
	`surprise` text,
	`confidence` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `records_inbox` ON `records` (`to_agent`,`id`);--> statement-breakpoint
CREATE INDEX `records_bean` ON `records` (`bean`,`id`);