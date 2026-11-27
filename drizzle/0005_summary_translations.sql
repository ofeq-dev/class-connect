CREATE TABLE `summary_translation` (
	`id` integer PRIMARY KEY NOT NULL,
	`summary_id` integer NOT NULL,
	`language` text NOT NULL,
	`markdown` text,
	`source_version_id` integer NOT NULL,
	`job_id` integer NOT NULL,
	`edited_at` integer,
	FOREIGN KEY (`summary_id`) REFERENCES `summary`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `summary_translation_language` ON `summary_translation` (`summary_id`,`language`);