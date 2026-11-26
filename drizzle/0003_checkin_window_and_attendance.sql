CREATE TABLE `attendance` (
	`id` integer PRIMARY KEY NOT NULL,
	`session_id` integer NOT NULL,
	`roster_entry_id` integer NOT NULL,
	`state` text NOT NULL,
	`ip` text,
	`block` text,
	`device_token_hash` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attendance_session_entry` ON `attendance` (`session_id`,`roster_entry_id`);--> statement-breakpoint
CREATE TABLE `check_in_window` (
	`id` integer PRIMARY KEY NOT NULL,
	`session_id` integer NOT NULL,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`lecturer_ipv4` text,
	`lecturer_ipv6` text
);
--> statement-breakpoint
CREATE INDEX `check_in_window_session` ON `check_in_window` (`session_id`,`opened_at`);