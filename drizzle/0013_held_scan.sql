CREATE TABLE `held_scan` (
	`id` integer PRIMARY KEY NOT NULL,
	`session_id` integer NOT NULL,
	`roster_entry_id` integer NOT NULL,
	`ip` text NOT NULL,
	`block` text,
	`device_token_hash` text NOT NULL,
	`at` integer NOT NULL,
	`decision` text,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `held_scan_session_entry` ON `held_scan` (`session_id`,`roster_entry_id`);