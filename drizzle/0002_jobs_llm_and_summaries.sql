CREATE TABLE `job` (
	`id` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`run_at` integer NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`progress_done` integer,
	`progress_total` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `job_status_run_at` ON `job` (`status`,`run_at`);--> statement-breakpoint
CREATE TABLE `llm_usage` (
	`day` text PRIMARY KEY NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `summary` (
	`id` integer PRIMARY KEY NOT NULL,
	`session_id` integer NOT NULL,
	`published_version_id` integer,
	`generation_job_id` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `summary_session` ON `summary` (`session_id`);--> statement-breakpoint
CREATE TABLE `summary_version` (
	`id` integer PRIMARY KEY NOT NULL,
	`summary_id` integer NOT NULL,
	`number` integer NOT NULL,
	`markdown` text NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`summary_id`) REFERENCES `summary`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `summary_version_summary` ON `summary_version` (`summary_id`,`number`);--> statement-breakpoint
CREATE TABLE `transcript` (
	`id` integer PRIMARY KEY NOT NULL,
	`session_id` integer NOT NULL,
	`file_hash` text,
	`file_name` text,
	`text` text NOT NULL,
	`has_timestamps` integer NOT NULL,
	`uploaded_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `transcript_session` ON `transcript` (`session_id`);