CREATE TABLE `course` (
	`id` integer PRIMARY KEY NOT NULL,
	`lecturer_id` integer NOT NULL,
	`name` text NOT NULL,
	`translation_languages` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`lecturer_id`) REFERENCES `lecturer`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `lecturer` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL
);
